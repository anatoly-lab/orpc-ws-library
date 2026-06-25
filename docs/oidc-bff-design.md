> ⚠️ **SUPERSEDED (2026-06-24)** — This doc proposed a **browser-bearer** model
> (the browser holds both access + refresh tokens in `localStorage`, fronted by a
> client-side `@orpc-ws/oidc-bff` package). That direction is **abandoned**: the
> consumer app will later run **sandboxed / untrusted JavaScript** in the page, so
> **no token may ever be readable by JavaScript** — a hard requirement the
> browser-bearer model cannot meet. The replacement is a **cookie-BFF /
> server-held-token** model where tokens never enter the browser at all. See
> **[`cookie-bff-server-design.md`](./cookie-bff-server-design.md)** for the live
> design. The rest of this file is retained for historical context only.

---

# Design — `@orpc-ws/oidc-core` + `@orpc-ws/oidc-bff`

**Status: design, implementation-ready.** The decision is made (two new
packages); this doc specifies the shape so it can be built directly.

**Source of truth for decisions:** `CLAUDE.md` (repo root).
**Motivating consumer:** `~/Developer/projects/ankimcp/anki-mcp-saas`
(`apps/web` + `apps/api`).
**Companion docs:** [`implementation-plan.md`](./implementation-plan.md),
[`migration-anki-mcp-saas.md`](./migration-anki-mcp-saas.md) (the WS-transport
half; this doc is the auth half).

---

## A. Motivation & goal

### The clean-boundary goal (frame everything around this)

The target end-state for a backend-mediated consumer app is: **the app has
ZERO auth implementation.** It declares *what* it wants —

- which HTTP endpoints run the OIDC dance (`login`, `callback`, `refresh`,
  `logout`),
- where to send the user on logout / on terminal auth failure,
- runtime config (base URL, scopes, skew) —

and the library does *how*:

- token **and user** storage (read/write/clear) — in a BFF the backend is the
  identity authority, so the authenticated `user` is the object the callback
  endpoint returns and the library persists it as-is,
- refresh **timing** (the WS client decides *when*; the auth layer decides
  *how* to refresh and how to interpret the outcome),
- expiry math (absolute-time conversion, skew),
- single-flight de-dup of concurrent refreshes,
- transient-vs-terminal **failure classification** + bounded retry,
- reconnect token plumbing (via the `TokenProvider` seam),
- React state (`useSyncExternalStore`-safe store, cross-tab sync).

Today, in `anki-mcp-saas/apps/web`, that "how" is **smeared across the app
and the library**: `auth.ts` owns refresh classification + single-flight;
`secure-storage.ts` owns token persistence + expiry; `jwt-utils.ts` owns JWT
parse; `websocket/index.ts` owns the retry-once-on-transient adapter;
`login.tsx` / `callback.tsx` own CSRF-state + the login/callback fetch dance;
`useAuth.ts` + `auth-events.ts` own a bespoke reactive store. That is ~505
lines of auth logic the app should not be carrying. This doc specifies the
two packages that let the app delete almost all of it.

> **The win is boundary clarity and cross-project reuse, not net LOC.**
> Total code *across both repos grows* (we add two packages with tests). The
> app shrinks; the library gains a reusable, tested topology. See §F.

### The three OIDC topologies

| Topology | Who holds refresh token | Who holds access token | Library coverage |
| --- | --- | --- | --- |
| **browser-direct PKCE** | browser | browser | `@orpc-ws/oidc-pkce` (+ `demo-pkce`) |
| **cookie-BFF** | server (session) | server (session) | `demo-cookie-bff` (no library pkg; cookie auth needs no `TokenProvider`) |
| **browser-bearer-BFF** | **browser** | **browser** | **GAP → `@orpc-ws/oidc-bff` (this doc)** |

`demo-backend-token` is a *fourth* variant — server holds the refresh token,
browser holds only a short-lived access token. It is **not** what `anki-mcp`
does today: `anki-mcp` puts **both** tokens in the browser's `localStorage`
and the server is a stateless OIDC proxy (`apps/api` `/api/auth/*`). No demo
and no library package covers that variant — every BFF consumer of this shape
hand-writes it. `@orpc-ws/oidc-bff` fills exactly that gap.

> **Constraint 1 — architecture stays browser-bearer for now.** This package
> does NOT move the refresh token server-side. That is a *future* swap
> (§I), made cheap by the pluggable storage seam (§D, constraint 2).

---

## B. Package layout

Two new packages mirror `oidc-pkce`'s `tshy` dual ESM+CJS setup.

### `packages/oidc-core/` (NEW — framework-free shared primitives)

```
packages/oidc-core/
├── package.json            # tshy dual ESM+CJS, zero runtime deps (mirror oidc-pkce)
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── README.md
└── src/
    ├── index.ts            # public barrel
    ├── types.ts            # Tokens, Storage, OidcUser, AuthStatus, Callback*, AuthClient
    ├── auth-store.ts       # createAuthStore + AuthSnapshot  (moved verbatim from oidc-pkce)
    ├── auth-view.ts        # createAuthView                  (moved verbatim from oidc-pkce)
    ├── jwt.ts              # parseJwt, parseIdToken, isTokenExpired  (split from oidc-pkce/tokens.ts)
    ├── storage.ts          # createLocalStorage(key) default Storage impl
    └── format-callback-error.ts   # moved from oidc-pkce
```

`package.json` (mirror `oidc-pkce` exactly; only `name`/`description` differ):

```jsonc
{
  "name": "@orpc-ws/oidc-core",
  "version": "0.3.0",                 // fixed-bumped to 0.4.0 on first publish (see below)
  "description": "Framework-free OIDC primitives shared by @orpc-ws/oidc-pkce and @orpc-ws/oidc-bff: value types, the cross-tab auth store, expiry/JWT helpers, and a default localStorage Storage.",
  "license": "MIT",
  "publishConfig": { "access": "public" },
  "files": ["dist", "src", "!src/**/*.test.ts", "!src/**/__tests__/**", "!src/package.json", "README.md"],
  "tshy": {
    "exports": { ".": "./src/index.ts" },
    "project": "./tsconfig.build.json",
    "exclude": ["src/**/*.test.ts", "src/**/__tests__/**"]
  },
  "scripts": {
    "build": "tshy", "prepublishOnly": "tshy",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run", "test:watch": "vitest",
    "lint": "eslint .", "clean": "rimraf dist .turbo .tshy-build .tsbuildinfo *.tsbuildinfo"
  },
  "devDependencies": { "@types/node": "26.0.0", "happy-dom": "20.10.6", "rimraf": "6.1.3", "typescript": "6.0.3", "vitest": "4.1.9" },
  "type": "module",
  "exports": { ".": { "import": { "types": "./dist/esm/index.d.ts", "default": "./dist/esm/index.js" }, "require": { "types": "./dist/commonjs/index.d.ts", "default": "./dist/commonjs/index.js" } } },
  "main": "./dist/commonjs/index.js",
  "types": "./dist/commonjs/index.d.ts",
  "module": "./dist/esm/index.js"
}
```

`oidc-core` keeps **zero runtime dependencies** (same as `oidc-pkce`).

### `packages/oidc-bff/` (NEW — browser-bearer BFF topology)

```
packages/oidc-bff/
├── package.json            # tshy dual ESM+CJS; depends on @orpc-ws/oidc-core
├── tsconfig.json / tsconfig.build.json / vitest.config.ts / README.md
└── src/
    ├── index.ts            # public barrel: createBffAuth, BffAuthConfig, re-export core types
    ├── types.ts            # BffAuthConfig, internal RefreshResult union
    ├── client.ts           # createBffAuth composition root  (mirrors oidc-pkce/client.ts)
    ├── flow.ts             # redirectToLogin / handleCallback / logout (HTTP-endpoint variants)
    ├── refresh.ts          # classify() + retry + single-flight; the tokenProvider seam
    ├── user-store.ts       # UserStore<TUser> + createLocalUserStore (persists the canonical callback user)
    └── endpoints.ts        # typed fetch wrappers for {login,callback,refresh,logout}
```

`package.json` `dependencies`: `{ "@orpc-ws/oidc-core": "workspace:*" }`.
Everything else mirrors `oidc-core`'s `package.json` (tshy, exports map,
devDeps).

### Changeset / versioning implication

`.changeset/config.json` uses a single **`fixed`** group:

```json
"fixed": [["@orpc-ws/shared", "@orpc-ws/oidc-pkce", "@orpc-ws/client",
  "@orpc-ws/server", "@orpc-ws/oidc-react", "@orpc-ws/react",
  "@orpc-ws/server-nestjs", "@orpc-ws/oidc-verifier-jose"]]
```

- **Both new packages MUST be added to this `fixed` array.** Fixed groups bump
  in lockstep — so publishing `oidc-core` + `oidc-bff` bumps *every* package
  to the same version. Current version is `0.3.0`; the first release that
  includes these is a **minor → `0.4.0`** (new packages = additive = minor).
- One changeset with a `minor` bump covers the whole group. Do **not** edit
  `package.json` `version` fields by hand (`CLAUDE.md` versioning rule).

---

## C. `@orpc-ws/oidc-core` public API

`oidc-core` is the home for everything in `oidc-pkce` that is **topology-
agnostic**. `oidc-pkce` then re-exports it all so its public surface is
**unchanged** (non-breaking).

### What moves out of `oidc-pkce` into `oidc-core`

| Symbol | Today (oidc-pkce) | Moves to oidc-core | oidc-pkce after |
| --- | --- | --- | --- |
| `Tokens` | `src/types.ts` | `types.ts` | re-export |
| `Storage` | `src/types.ts` | `types.ts` | re-export |
| `OidcUser` | `src/types.ts` | `types.ts` | re-export |
| `AuthStatus` | `src/types.ts` | `types.ts` | re-export |
| `CallbackError` | `src/types.ts` | `types.ts` | re-export |
| `CallbackResult` | `src/types.ts` | `types.ts` | re-export |
| `TokenProvider` | `src/types.ts` | `types.ts` | re-export |
| `AuthSnapshot<TUser>` | `src/auth-store.ts` | `auth-store.ts` (made generic) | re-export |
| `createAuthStore`, `AuthStore`, `AuthStoreDeps` | `src/auth-store.ts` | `auth-store.ts` (verbatim) | (internal use via core) |
| `createAuthView<TUser>`, `AuthView<TUser>` | `src/auth-view.ts` | `auth-view.ts` (+injected `resolveUser`) | (internal use via core) |
| `parseJwt`, `parseIdToken`, `isTokenExpired` | `src/tokens.ts` | `jwt.ts` (split out) | import from core |
| `formatCallbackError` | `src/format-callback-error.ts` | `format-callback-error.ts` (verbatim) | re-export |
| `AuthClient<TUser>` (NEW) | — | `types.ts` | oidc-pkce's `OidcAuth` = `AuthClient<OidcUser>` |

**Stays in `oidc-pkce`** (PKCE/issuer-specific, NOT moved): `OidcConfig`,
`OidcMetadata`, `OidcDiscoveryError`, `discovery.ts`, `pkce.ts`, `flow.ts`,
`tokenResponseToBundle`/`exchangeCodeForTokens`/`refreshTokens` (the
IdP-token-endpoint exchanges), and `createOidcAuth`/`OidcAuth`.

> **Note on `tokens.ts` split:** `oidc-pkce/src/tokens.ts` currently mixes
> pure JWT/expiry helpers (`parseJwt`, `parseIdToken`, `isTokenExpired`) with
> IdP-endpoint exchanges (`exchangeCodeForTokens`, `refreshTokens`,
> `tokenResponseToBundle`). Only the **pure** trio moves to
> `oidc-core/jwt.ts`. `oidc-pkce/tokens.ts` keeps the exchanges and
> re-imports the trio from core (e.g. `auth-view.ts` and `flow.ts` already
> consume `isTokenExpired` / `parseIdToken`).

### Core types (`oidc-core/src/types.ts`)

`Tokens`, `Storage`, `OidcUser`, `AuthStatus`, `CallbackError`,
`CallbackResult`, `TokenProvider` move **verbatim** from
`oidc-pkce/src/types.ts` (signatures unchanged — see that file for the
authoritative jsdoc). Reproduced here for the record:

```ts
export interface Tokens { accessToken: string; refreshToken: string; idToken: string; expiresAt: number; }

export interface Storage {
  read(): Tokens | null;
  write(tokens: Tokens): void;
  clear(): void;
}

export interface OidcUser { sub: string; email?: string; name?: string; preferredUsername?: string; }

export type AuthStatus = "authenticated" | "expired" | "anonymous";

export type CallbackError =
  | { type: "state_mismatch" }
  | { type: "missing_code" }
  | { type: "exchange_failed"; status: number; body: string }
  | { type: "idp_error"; error: string; description?: string };

export type CallbackResult =
  | { ok: true; user: OidcUser; tokens: Tokens }
  | { ok: false; error: CallbackError };

export interface TokenProvider {
  getToken(): string | null;
  refresh(): Promise<string | null>;
}
```

#### NEW — `AuthClient<TUser>` (the narrowed React-facing interface)

A small interface that **both** `oidc-pkce`'s `OidcAuth` and `oidc-bff`'s
client satisfy. It is the union of methods the React bindings actually use —
no `prefetchMetadata` (PKCE-specific), no `hasToken`/`isAccessTokenValid`
(unused by the hooks).

It is **generic over the user shape**, defaulted to `OidcUser`, so a BFF
consumer whose backend enriches the user with app-domain fields (e.g. a DB
`id` and a `role`) gets those fully typed instead of `any`. The default
`TUser = OidcUser` keeps every existing consumer non-breaking — `oidc-pkce`'s
`OidcAuth` is exactly `AuthClient<OidcUser>`.

```ts
import type { AuthSnapshot } from "./auth-store.js";

export interface AuthClient<TUser = OidcUser> {
  /** Synchronous, referentially-stable snapshot of `{ status, user }`. */
  getAuthState(): AuthSnapshot<TUser>;
  /** Register a change listener; returns unsubscribe. Stable identity. */
  subscribe(listener: () => void): () => void;
  /** Current user, or null. */
  getUser(): TUser | null;
  /** Coarse status derived from stored-token expiry. */
  getAuthStatus(): AuthStatus;
  /** Run the redirect-back exchange once; never throws (returns a union). */
  handleCallback(searchParams: URLSearchParams): Promise<CallbackResult>;
  /** Begin login (navigates the page). */
  redirectToLogin(): Promise<void>;
  /** Clear session; may navigate to the IdP/BFF end-session URL. */
  logout(opts?: { redirectTo?: string }): Promise<void>;
  /** Wipe local tokens without an IdP round-trip. */
  clearTokens(): void;
  /** The `@orpc-ws/client`-compatible token seam. */
  tokenProvider: TokenProvider;
}
```

`oidc-pkce`'s `OidcAuth` already declares every one of these methods (see
`oidc-pkce/src/client.ts` lines 54–103), so `OidcAuth` is **structurally
assignable** to `AuthClient<OidcUser>` (the default instantiation) with no
code change. We make that explicit by having `oidc-pkce` re-export
`AuthClient` and adding a compile-time assertion in `oidc-pkce`
(`const _assert: AuthClient = {} as OidcAuth;` in a type-test) so drift fails
loudly in the library, not at a consumer's site.

### Core store / view / jwt / storage

- `createAuthStore` + `AuthSnapshot<TUser>` + `AuthStore` + `AuthStoreDeps` —
  **moved verbatim** from `oidc-pkce/src/auth-store.ts` (cross-tab `'storage'`
  wiring, dirty-flag lazy rebuild, `Object.is`-stable snapshot). The only
  change is that `AuthSnapshot` becomes generic over the user shape —
  `AuthSnapshot<TUser = OidcUser> = { status: AuthStatus; user: TUser | null }`
  — so the BFF's enriched user threads through `getAuthState()`. Defaulted to
  `OidcUser`, so PKCE is unchanged. No behavior change.
- `createAuthView<TUser>` + `AuthView<TUser>` — **moved (near-)verbatim** from
  `oidc-pkce/src/auth-view.ts` (status-from-expiry; user resolution with
  per-id-token memoization). The one addition is **dependency-injected user
  resolution** (DIP): `createAuthView` takes an optional `resolveUser`
  strategy whose **default reproduces today's PKCE behavior** (parse the
  id_token). The two topologies thus differ only at their composition roots —
  `oidc-core` itself has **no** `if (bff)` branch.

  ```ts
  /**
   * `resolveUser` maps the stored token bundle to the authenticated user.
   * Default = parse the id_token (PKCE behavior, unchanged). `oidc-bff`
   * injects a strategy that returns the persisted callback `user` instead,
   * because in a BFF the backend (not the id_token) is the identity authority.
   */
  export function createAuthView<TUser = OidcUser>(
    storage: Storage,
    resolveUser: (tokens: Tokens) => TUser | null =
      (tokens) => parseIdToken(tokens.idToken) as TUser | null,
  ): AuthView<TUser> { /* status-from-expiry + memoized readUser */ }
  ```

  > Chosen as a **strategy/DIP** seam rather than a behavioral `bff: boolean`
  > flag: a flag would put a topology `if` inside core (closed-for-extension
  > smell); injecting `resolveUser` keeps core open/closed and the two
  > callers' difference lives at their composition roots, not in shared code.
- `jwt.ts` — `parseJwt(token): Record<string, unknown> | null`,
  `parseIdToken(idToken): OidcUser | null`, `isTokenExpired(tokens): boolean`
  (verbatim from `oidc-pkce/src/tokens.ts`).
- `storage.ts` — **NEW** factored default impl, extracted from the private
  `defaultStorage()` in `oidc-pkce/src/client.ts` (lines 127–149) and
  parameterized by key:

  ```ts
  /** Default localStorage-backed Storage: single JSON blob under one key. */
  export function createLocalStorage(key: string): Storage {
    return {
      read(): Tokens | null {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        try { return JSON.parse(raw) as Tokens; } catch { return null; }
      },
      write(tokens: Tokens): void { localStorage.setItem(key, JSON.stringify(tokens)); },
      clear(): void { localStorage.removeItem(key); },
    };
  }
  ```

  `oidc-pkce`'s `defaultStorage()` becomes `createLocalStorage("oidc.tokens")`
  (its `DEFAULT_STORAGE_KEY` is unchanged, so existing PKCE consumers keep the
  same localStorage key — no re-login for them).

### `oidc-core/src/index.ts` (public barrel)

```ts
export type {
  Tokens, Storage, OidcUser, AuthStatus,
  CallbackError, CallbackResult, TokenProvider, AuthClient,
} from "./types.js";
export { createAuthStore } from "./auth-store.js";
export type { AuthSnapshot, AuthStore, AuthStoreDeps } from "./auth-store.js";
export { createAuthView } from "./auth-view.js";
export type { AuthView } from "./auth-view.js";
export { parseJwt, parseIdToken, isTokenExpired } from "./jwt.js";
export { createLocalStorage } from "./storage.js";
export { formatCallbackError } from "./format-callback-error.js";
```

### The re-export shim that keeps `oidc-pkce` non-breaking

`oidc-pkce/src/index.ts` keeps the **same exported names**, sourced from core:

```ts
export { createOidcAuth, type OidcAuth } from "./client.js";
export { OidcDiscoveryError, type OidcConfig, type OidcMetadata } from "./types.js";

// Re-export the promoted core symbols so the public API is UNCHANGED.
export {
  formatCallbackError, createAuthStore, createAuthView,
  parseJwt, parseIdToken, isTokenExpired, createLocalStorage,
} from "@orpc-ws/oidc-core";
export type {
  Tokens, Storage, OidcUser, AuthStatus, CallbackError, CallbackResult,
  TokenProvider, AuthSnapshot, AuthClient,
} from "@orpc-ws/oidc-core";
```

`oidc-pkce` gains a runtime dep on `@orpc-ws/oidc-core` (`workspace:*`). Its
public surface is a **superset** of today's (adds `createLocalStorage`,
`parseJwt`, `createAuthStore`/`createAuthView`, `AuthClient`), which is still
non-breaking. `createOidcAuth` internally now imports the store/view/jwt/
storage from core instead of local files.

---

## D. `@orpc-ws/oidc-bff` public API

### `BffAuthConfig` (`oidc-bff/src/types.ts`)

```ts
import type { OidcUser, Storage } from "@orpc-ws/oidc-core";
import type { Logger } from "@orpc-ws/shared";

export interface BffAuthEndpoints {
  /** GET → `{ url, state }`. The app's `/api/auth/login`. */
  login: string;
  /** POST `{ code, state }` → `{ ...tokens, user }`. The app's `/api/auth/callback`.
   *  The `user` is the canonical identity (see handleCallback). */
  callback: string;
  /** POST `{ refreshToken }` → `{ accessToken, refreshToken?, expiresIn }`. */
  refresh: string;
  /** POST `{ idToken? }` → `{ logoutUrl?: string | null }` (optional). */
  logout?: string;
}

export interface BffRetryConfig {
  /** Bounded retries on a TRANSIENT refresh failure. Default 1. */
  retries?: number;
  /** Delay between transient retries, ms. Default 1000. */
  delayMs?: number;
}

export type LoginMode = "fetch" | "redirect";

export interface BffAuthConfig<TUser = OidcUser> {
  endpoints: BffAuthEndpoints;
  /**
   * Base origin the relative endpoint paths resolve against, e.g.
   * "https://api.example.com". `string` OR a thunk for runtime config
   * injection (anki-mcp resolves this from window.__APP_CONFIG__ at runtime,
   * see apps/web/src/lib/config.ts) — mirrors @orpc-ws/client's
   * `url: string | (() => string)`. If endpoints are absolute URLs, pass "".
   */
  baseUrl: string | (() => string);
  /**
   * - "fetch"   : GET `login` → `{ url, state }`, persist `state`, then
   *               `location.assign(url)`. (anki-mcp's current behavior.)
   * - "redirect": `location.assign(login)` directly; the server sets a
   *               state cookie and does the IdP redirect itself.
   * Default: "fetch".
   */
  loginMode?: LoginMode;
  /**
   * CSRF-state verification on callback. When true (default) the library
   * persists the `state` from the login response and verifies the callback's
   * `state` matches before POSTing. Set false for apps that verify state
   * server-side only.
   */
  verifyState?: boolean;
  /** Seconds shaved off the IdP's `expires_in` before computing `expiresAt`. Default 30. */
  expirySkewSeconds?: number;
  retry?: BffRetryConfig;
  /** Token + user persistence seam. Default: createLocalStorage("orpc-ws.bff.tokens"). */
  storage?: Storage;
  /**
   * ESCAPE HATCH — adapt the server's callback `user` JSON to `TUser`. Used
   * ONLY when the wire shape needs reshaping (rename/normalize fields). By
   * DEFAULT the callback `user` is stored and surfaced **as-is** ("callback
   * response is canonical", see handleCallback below) — leave this undefined
   * unless your server's JSON doesn't already match `TUser`.
   */
  mapCallbackUser?: (raw: unknown) => TUser;
  /** Pino-shape logger. Default: noop. */
  logger?: Logger;
  /** TEST seam: injected fetch. Default: globalThis.fetch (bound). */
  fetchImpl?: typeof fetch;
  /** TEST seam: injected `now()`. Default: () => Date.now(). */
  clock?: { now(): number };
}
```

> **`expirySkewSeconds` matches the app.** `anki-mcp`'s `secure-storage.ts`
> computes `expiresAt = Date.now() + (expiresIn - 30) * 1000`. The 30s skew
> moves here as a config default so the "refresh slightly early" behavior is
> preserved without the app owning it.

### User persistence — the `UserStore<TUser>` sibling seam (`oidc-bff/src/user-store.ts`)

In a BFF the authenticated identity is the `user` object the backend returns
from `/api/auth/callback` — and `refresh()` does **not** return a user (it
returns only tokens), so the stored user must persist across refreshes (this
matches anki-mcp today, where `localStorage("user")` outlives token refresh).
The reactive view and cross-tab sync both read it, so it has to live in
durable storage, not just memory.

`oidc-core`'s `Storage` seam is intentionally typed for `Tokens` only — we do
**not** widen it (that would ripple into `oidc-pkce`, which has no user to
persist). Instead `oidc-bff` adds a **sibling** `UserStore<TUser>` that
persists the user blob under a **sibling localStorage key** derived from the
token key. A single key suffix keeps it co-located with the tokens so the
BFF client's `clear()` wipes **both** atomically, and writing it through
`localStorage` means the cross-tab `'storage'` event still fires (so a logout
in one tab flips the others).

```ts
import type { OidcUser } from "@orpc-ws/oidc-core";

/** Persists the BFF callback `user` alongside the tokens (sibling key). */
export interface UserStore<TUser = OidcUser> {
  read(): TUser | null;
  write(user: TUser): void;
  clear(): void;
}

/** Default: same localStorage backend, key = `${tokenKey}.user`. */
export function createLocalUserStore<TUser = OidcUser>(tokenKey: string): UserStore<TUser> {
  const key = `${tokenKey}.user`;
  return {
    read(): TUser | null {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      try { return JSON.parse(raw) as TUser; } catch { return null; }
    },
    write(user: TUser): void { localStorage.setItem(key, JSON.stringify(user)); },
    clear(): void { localStorage.removeItem(key); },
  };
}
```

> **Why a sibling key, not a merged blob:** keeping the `user` next to the
> `Tokens` blob (single source for "who am I") gives an **atomic clear** (one
> `clear()` wipes tokens + user) and preserves **cross-tab sync** (the
> `'storage'` event fires on the user key just as on the token key). Co-locating
> via a key *suffix* — rather than widening the shared `Tokens` shape — leaves
> `oidc-core`'s `Storage` and `oidc-pkce` untouched (PKCE keeps deriving its
> user from the id_token and persists no user at all). The BFF's `resolveUser`
> strategy (injected into `createAuthView`) simply reads `userStore.read()`.

### `createBffAuth<TUser>(config): AuthClient<TUser>` (`oidc-bff/src/client.ts`)

The composition root — mirrors `oidc-pkce/src/client.ts`, generic over the
user shape (defaulted to `OidcUser`, so the call site is unchanged for the
common case). It wires `createLocalStorage` + `createLocalUserStore`
(defaults) + `createAuthView` (with a `resolveUser` that reads the persisted
user) + `createAuthStore` (from core) + the refresh seam (from `refresh.ts`) +
the flow helpers (from `flow.ts`).

```ts
import {
  createAuthStore, createAuthView, createLocalStorage,
  type AuthClient, type AuthStatus,
  type CallbackResult, type OidcUser, type Storage, type TokenProvider,
} from "@orpc-ws/oidc-core";
import { noopLogger } from "@orpc-ws/shared";
import { createLocalUserStore, type UserStore } from "./user-store.js";
import { createTokenProvider } from "./refresh.js";
import { redirectToLogin, handleCallback, logout } from "./flow.js";

const DEFAULT_STORAGE_KEY = "orpc-ws.bff.tokens";

export function createBffAuth<TUser extends OidcUser = OidcUser>(
  config: BffAuthConfig<TUser>,
): AuthClient<TUser> {
  const usingDefaultStorage = config.storage === undefined;
  const storage: Storage = config.storage ?? createLocalStorage(DEFAULT_STORAGE_KEY);
  const userStore: UserStore<TUser> = createLocalUserStore<TUser>(DEFAULT_STORAGE_KEY);
  const logger = config.logger ?? noopLogger;
  const now = config.clock?.now ?? (() => Date.now());
  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const resolveBase = typeof config.baseUrl === "function" ? config.baseUrl : () => config.baseUrl as string;

  // BFF identity = the persisted callback `user`, NOT the id_token. This is
  // the injected DIP strategy that overrides core's id-token default.
  const view = createAuthView<TUser>(storage, () => userStore.read());
  const authStore = createAuthStore({
    getStatus: view.readStatus,
    getUser: view.readUser,
    storageKey: usingDefaultStorage ? DEFAULT_STORAGE_KEY : null,
  });

  // The single-flight + classify + retry token seam. Emits on a successful
  // refresh so reactive UIs flip `expired` → `authenticated`. (See §D refresh.ts.)
  const tokenProvider: TokenProvider = createTokenProvider({
    storage, config, resolveBase, fetchImpl, now, logger,
    onRefreshed: () => authStore.emit(),
  });

  return {
    getAuthState: authStore.getAuthState,
    subscribe: authStore.subscribe,
    getUser: view.readUser,
    getAuthStatus: view.readStatus,

    redirectToLogin: () => redirectToLogin({ config, resolveBase, fetchImpl, logger }),
    handleCallback: async (params) => {
      // handleCallback persists tokens AND the server-returned user.
      const result = await handleCallback<TUser>({ params, storage, userStore, config, resolveBase, fetchImpl, now });
      authStore.emit(); // no-op when nothing changed (store value-compares)
      return result;
    },
    logout: async (opts) => {
      await logout({ storage, userStore, config, resolveBase, fetchImpl, opts });
      authStore.emit();
    },
    clearTokens: () => { storage.clear(); userStore.clear(); authStore.emit(); },

    tokenProvider,
  };
}
```

### Internal refresh classification + the tokenProvider seam (`oidc-bff/src/refresh.ts`)

This is the heart of the package. It ports `anki-mcp`'s `auth.ts`
`RefreshResult` classification **verbatim** in spirit, but keeps it
**internal** — the public `TokenProvider.refresh(): Promise<string | null>`
contract is unchanged. The `string | null` collapse happens at the very edge.

```ts
import type { Storage, TokenProvider } from "@orpc-ws/oidc-core";
import type { Logger } from "@orpc-ws/shared";

/** Internal-only outcome of one refresh attempt. NOT exported. */
type RefreshResult =
  | { status: "refreshed"; token: string }
  | { status: "terminal" }    // refresh token genuinely dead — give up
  | { status: "transient" };  // recoverable blip — bounded retry

interface RefreshResponse { accessToken: string; refreshToken?: string; expiresIn: number; }

function isRefreshResponse(v: unknown): v is RefreshResponse {
  return typeof v === "object" && v !== null
    && typeof (v as Record<string, unknown>).accessToken === "string";
}

/**
 * One refresh attempt against the BFF `refresh` endpoint.
 * Classification rules (ported from anki-mcp apps/web/src/lib/auth.ts):
 *   - missing refresh token in storage          -> terminal
 *   - fetch throws (network)                     -> transient
 *   - 5xx / 429 / 408 / 425                      -> transient
 *   - any other non-2xx (401/400 invalid_grant) -> terminal
 *   - 2xx but unparseable / wrong shape          -> transient
 *   - 2xx parseable                              -> refreshed (writes storage)
 */
async function attemptRefresh(deps: {
  storage: Storage; config: BffAuthConfig; resolveBase: () => string;
  fetchImpl: typeof fetch; now: () => number; logger: Logger;
}): Promise<RefreshResult> {
  const current = deps.storage.read();
  if (!current?.refreshToken) return { status: "terminal" };

  const url = deps.resolveBase() + deps.config.endpoints.refresh;
  let res: Response;
  try {
    res = await deps.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: current.refreshToken }),
    });
  } catch {
    return { status: "transient" };
  }

  if (!res.ok) {
    if (res.status >= 500 || res.status === 429 || res.status === 408 || res.status === 425) {
      return { status: "transient" };
    }
    return { status: "terminal" };
  }

  let body: unknown;
  try { body = await res.json(); } catch { return { status: "transient" }; }
  if (!isRefreshResponse(body)) return { status: "transient" };

  const skew = deps.config.expirySkewSeconds ?? 30;
  deps.storage.write({
    accessToken: body.accessToken,
    refreshToken: body.refreshToken ?? current.refreshToken, // keep prior if not rotated
    idToken: current.idToken,                                 // refresh doesn't return id_token
    expiresAt: deps.now() + Math.max(0, body.expiresIn - skew) * 1000,
  });
  return { status: "refreshed", token: body.accessToken };
}

export function createTokenProvider(deps: {
  storage: Storage; config: BffAuthConfig; resolveBase: () => string;
  fetchImpl: typeof fetch; now: () => number; logger: Logger;
  onRefreshed: () => void;
}): TokenProvider {
  const retries = deps.config.retry?.retries ?? 1;
  const delayMs = deps.config.retry?.delayMs ?? 1000;
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // Single-flight: concurrent refresh() calls share one in-flight promise.
  let inflight: Promise<string | null> | null = null;

  return {
    // Deliberately dumb: stored access token AS-IS (even if expired). The WS
    // client sends it, observes the 1008/4001 close, then calls refresh().
    getToken: () => deps.storage.read()?.accessToken ?? null,

    refresh(): Promise<string | null> {
      if (inflight) return inflight;
      inflight = (async (): Promise<string | null> => {
        let result = await attemptRefresh(deps);
        // Bounded retry ONLY on transient. terminal short-circuits immediately.
        for (let i = 0; i < retries && result.status === "transient"; i++) {
          await delay(delayMs);
          result = await attemptRefresh(deps);
        }
        if (result.status === "refreshed") {
          deps.onRefreshed();             // notify reactive UI
          return result.token;            // collapse union -> string at the edge
        }
        return null;                      // terminal OR exhausted transient -> null
      })().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
```

#### Why classification stays in the auth layer, not the transport (SRP)

The `@orpc-ws/client` transport only needs a **binary** answer: "can I keep
this connection going — yes (a token) or no (null)?" (see
`OrpcWsClientOptions.tokenProvider` in `orpc-ws-client/src/index.ts`). The
*reason* a refresh failed (dead token vs. network blip vs. throttle) is an
**auth-domain** concern: it decides whether to retry, how many times, and how
long to wait. Pushing transient/terminal into the transport would force the
WS client to grow knowledge of HTTP status semantics it has no business
owning. Keeping classification here means:

- the transport's contract stays `Promise<string | null>` (unchanged), and
- the storm-guard / single-flight on the transport side composes cleanly with
  the auth layer's own single-flight (both are cheap idempotent guards).

This is exactly the split `anki-mcp` evolved by hand: `auth.ts` classifies
into `RefreshResult`; `websocket/index.ts` collapses it to `string | null` for
the library. `oidc-bff` absorbs **both** halves so the app writes neither.

### Login / callback / logout orchestration (`oidc-bff/src/flow.ts`)

```ts
const STATE_KEY = "orpc-ws.bff.oauth_state"; // localStorage, survives the IdP redirect

export async function redirectToLogin(deps: {
  config: BffAuthConfig; resolveBase: () => string; fetchImpl: typeof fetch; logger: Logger;
}): Promise<void> {
  const { config } = deps;
  const loginUrl = deps.resolveBase() + config.endpoints.login;

  if ((config.loginMode ?? "fetch") === "redirect") {
    window.location.assign(loginUrl);   // server owns state-cookie + IdP redirect
    return;
  }
  // "fetch" mode (anki-mcp default): GET login → { url, state }, persist state, redirect.
  const res = await deps.fetchImpl(loginUrl, { method: "GET", headers: { "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`BFF login failed: ${res.status}`);
  const { url, state } = (await res.json()) as { url: string; state: string };
  if (config.verifyState ?? true) localStorage.setItem(STATE_KEY, state);
  window.location.assign(url);
}

export async function handleCallback<TUser extends OidcUser = OidcUser>(deps: {
  params: URLSearchParams; storage: Storage; userStore: UserStore<TUser>;
  config: BffAuthConfig<TUser>;
  resolveBase: () => string; fetchImpl: typeof fetch; now: () => number;
}): Promise<CallbackResult> {
  const { params, config } = deps;
  const errorParam = params.get("error");
  if (errorParam) {
    return { ok: false, error: { type: "idp_error", error: errorParam,
      ...(params.get("error_description") ? { description: params.get("error_description")! } : {}) } };
  }
  const code = params.get("code");
  const state = params.get("state");
  if (!code) return { ok: false, error: { type: "missing_code" } };

  if (config.verifyState ?? true) {
    const stored = localStorage.getItem(STATE_KEY);
    localStorage.removeItem(STATE_KEY);
    if (!state || state !== stored) return { ok: false, error: { type: "state_mismatch" } };
  }

  let res: Response;
  try {
    res = await deps.fetchImpl(deps.resolveBase() + config.endpoints.callback, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state }),
    });
  } catch (e) {
    return { ok: false, error: { type: "exchange_failed", status: 0, body: e instanceof Error ? e.message : String(e) } };
  }
  if (!res.ok) return { ok: false, error: { type: "exchange_failed", status: res.status, body: await res.text().catch(() => "") } };

  const t = (await res.json()) as {
    accessToken: string; refreshToken?: string; idToken: string;
    expiresIn: number; user: unknown;
  };
  const skew = config.expirySkewSeconds ?? 30;
  const tokens: Tokens = {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken ?? "",
    idToken: t.idToken,
    expiresAt: deps.now() + Math.max(0, t.expiresIn - skew) * 1000,
  };
  deps.storage.write(tokens);

  // CALLBACK RESPONSE IS CANONICAL. In a BFF the backend is the identity
  // authority — it enriches the user from its own DB (e.g. `id`, `role`) with
  // fields the id_token never carried. Persist the server-returned `user`
  // as-is (or via the optional `mapCallbackUser` adapter); the id_token is
  // used elsewhere ONLY for expiry/validity, never for identity.
  const user = (config.mapCallbackUser ? config.mapCallbackUser(t.user) : (t.user as TUser));
  deps.userStore.write(user);
  return { ok: true, user, tokens };
}

export async function logout(deps: {
  storage: Storage; userStore: UserStore; config: BffAuthConfig;
  resolveBase: () => string;
  fetchImpl: typeof fetch; opts?: { redirectTo?: string };
}): Promise<void> {
  const idToken = deps.storage.read()?.idToken;
  deps.storage.clear();
  deps.userStore.clear();
  const path = deps.config.endpoints.logout;
  if (!path) { if (deps.opts?.redirectTo) window.location.assign(deps.opts.redirectTo); return; }
  try {
    const res = await deps.fetchImpl(deps.resolveBase() + path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(idToken ? { idToken } : {}),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { logoutUrl?: string | null };
      window.location.assign(body.logoutUrl ?? deps.opts?.redirectTo ?? "/");
      return;
    }
  } catch { /* fall through */ }
  if (deps.opts?.redirectTo) window.location.assign(deps.opts.redirectTo);
}
```

> **`handleCallback` persists and returns the server's `user` blob** — the
> object `/api/auth/callback` returns — NOT an id-token-derived user. This was
> verified against `anki-mcp`: its API enriches the user from its own
> Users-service DB before returning, so the callback `user` carries fields the
> id_token never had — notably a DB `id` (≠ the Keycloak `sub`) and a `role`
> (roles map to the *access* token, not the id_token), and the UI reads both
> (Settings reads `id`; the `ProtectedRoute` guard reads `role`). Deriving the
> user from the id_token would silently drop them — a correctness bug, and for
> `role` a guard-bypass. So in the BFF the **backend is the identity
> authority** and its callback response is canonical; the id_token is used
> only for expiry/validity. `oidc-pkce` is unchanged — with no backend to ask,
> the id_token legitimately stays its only user source (the injected
> `resolveUser` default). The optional `mapCallbackUser` adapts the JSON shape
> when needed; otherwise the `user` is stored as-is.

### `oidc-bff/src/index.ts`

```ts
export { createBffAuth } from "./client.js";
export type {
  BffAuthConfig, BffAuthEndpoints, BffRetryConfig, LoginMode,
} from "./types.js";
export { createLocalUserStore } from "./user-store.js";
export type { UserStore } from "./user-store.js";
// Re-export the core types a consumer touches, so they import from one place.
export type {
  AuthClient, AuthSnapshot, AuthStatus, CallbackError, CallbackResult,
  OidcUser, Storage, TokenProvider, Tokens,
} from "@orpc-ws/oidc-core";
export { formatCallbackError } from "@orpc-ws/oidc-core";
```

---

## E. React bindings

`@orpc-ws/oidc-react` is **repointed** from `OidcAuth` (an `oidc-pkce`
concretion) to the narrowed, **generic** `AuthClient<TUser>` (an `oidc-core`
interface). After this, the same hooks work for **both** PKCE and BFF clients,
and a BFF consumer gets `user.role` / `user.id` fully typed through the
hooks (no `any`).

### Changes (4 files), all type-only, non-breaking

The hooks gain a `<TUser>` type parameter, **defaulted to `OidcUser`**, so
existing call sites infer the same `OidcUser` they do today (non-breaking) and
a BFF consumer can pass its enriched user type to get it back from `useUser` /
`useAuthState`.

| File | Today | After |
| --- | --- | --- |
| `src/oidc/use-auth-state.ts` | `import type { AuthSnapshot, OidcAuth } from "@orpc-ws/oidc-pkce"`; param `client: OidcAuth` | `import type { AuthClient, AuthSnapshot } from "@orpc-ws/oidc-core"`; `useAuthState<TUser = OidcUser>(client: AuthClient<TUser>): AuthSnapshot<TUser>` |
| `src/oidc/use-user.ts` | `OidcAuth` | `useUser<TUser = OidcUser>(client: AuthClient<TUser>): TUser \| null` (from core) |
| `src/oidc/use-oidc-callback.ts` | `import type { CallbackError, OidcAuth } from "@orpc-ws/oidc-pkce"`; param `client: OidcAuth` | `import type { AuthClient, CallbackError } from "@orpc-ws/oidc-core"`; param `client: AuthClient<TUser>` (`<TUser = OidcUser>`) |
| `src/oidc/require-auth.tsx` | `OidcAuth` (props + `DefaultSignedOut`) | `AuthClient<TUser>` (`<TUser = OidcUser>`) |

`package.json` dependency flips from `@orpc-ws/oidc-pkce: workspace:*` to
`@orpc-ws/oidc-core: workspace:*` (it now imports types from core only —
hooks use `getAuthState` / `subscribe` / `handleCallback` / `redirectToLogin`,
all on `AuthClient`).

**Non-breaking for existing PKCE consumers:** the `<TUser>` parameters are
type-only and default to `OidcUser`, and `OidcAuth` *satisfies*
`AuthClient<OidcUser>` (it declares a superset of methods). Passing an
`OidcAuth` where the hook now wants an `AuthClient` type-checks unchanged, and
existing call sites that never wrote a type argument infer `OidcUser` exactly
as before. There is **no `prefetchMetadata` no-op** carried for compat — the
hooks never referenced it.

### How apps drop their own hooks

| Library binding | Replaces the app's hand-rolled… |
| --- | --- |
| `useAuthState(client)` | `useAuth.ts` + `auth-events.ts` (the bespoke pub-sub store) |
| `useUser(client)` | `authStorage.getUser()` reads scattered across components |
| `RequireAuth client={…} fallback={<SignIn/>}` | per-page "signed out? show sign-in" checks |
| `useOidcCallback(client, { onSuccess })` | `callback.tsx`'s ref-guarded fetch dance |

---

## F. Consumer migration (`apps/web`)

The app already migrated its **WS transport** to `@orpc-ws/client` (see
`apps/web/src/lib/websocket/index.ts`). This is the **auth** half. Goal:
delete every file whose job the library now owns.

### Before → after, per file

| App file | LOC | Fate | Why |
| --- | --- | --- | --- |
| `lib/auth.ts` | ~198 | **delete** | refresh classify + single-flight + token storage glue → `oidc-bff` |
| `lib/secure-storage.ts` | ~101 | **delete** | token persistence + expiry → core `createLocalStorage` + `isTokenExpired` |
| `lib/jwt-utils.ts` | ~41 | **delete** | JWT parse/expiry → core `parseJwt` / `isTokenExpired` |
| `lib/auth-events.ts` | ~39 | **delete** | bespoke pub-sub → core `createAuthStore` (via `useAuthState`) |
| `hooks/useAuth.ts` | ~37 | **delete** | → `useAuthState(authClient)` from `@orpc-ws/oidc-react` |
| `pages/Auth/login.tsx` | ~77 | **shrink** to ~25 | login fetch + CSRF-state → `authClient.redirectToLogin()`; keep the JSX shell |
| `pages/Auth/callback.tsx` | ~94 | **shrink** to ~20 | callback dance → `useOidcCallback`; keep the spinner JSX |
| `lib/websocket/index.ts` | ~91 | **shrink** to ~30 | drop the `tokenProvider` + transient-retry adapter (now in `authClient.tokenProvider`) |
| **`lib/auth-failure.ts`** | ~38 | **KEEP** | app policy: *where* to redirect on terminal failure + the on-route guard. Library can't own product routing. |
| **`lib/config.ts`** | ~72 | **KEEP** | runtime config (`window.__APP_CONFIG__`, ws/api URL derivation) — pure app concern; feeds `baseUrl`/`url` thunks. |
| **`@repo/orpc-contract` `/api/auth/*`** | — | **KEEP** | the wire contract; `oidc-bff` *calls* these endpoints, doesn't replace them. |
| **`apps/api` server-side PKCE** (`auth.service.ts` etc.) | — | **KEEP** | the BFF server *is* the OIDC proxy; browser-bearer means the server still runs PKCE + state KV + token exchange. |

**Approx auth-implementation lines in the app: ~505 → ~55** (wiring/config):

- deleted: `auth.ts` 198 + `secure-storage.ts` 101 + `jwt-utils.ts` 41 +
  `auth-events.ts` 39 + `useAuth.ts` 37 = **416 deleted outright**
- shrunk: `login.tsx` 77→25, `callback.tsx` 94→20, `websocket/index.ts`
  91→30 (auth portion ~60→~10) ≈ **~90 of remaining ~135 lines removed**
- new wiring: a ~15-line `lib/auth.ts` (the `createBffAuth` call) + the
  shrunk pages ≈ **~55 lines of declaration/config**

> Restating the framing: **net code across both repos grows** (two packages +
> a demo + tests). The app's auth surface drops by ~90%, and the logic is now
> tested once in the library instead of hand-maintained per app.

### After — the final `apps/web/src/lib/auth.ts` (~15 lines)

```ts
// The app's ENTIRE auth implementation: declare WHAT, the library does HOW.
import { createBffAuth, type OidcUser } from "@orpc-ws/oidc-bff";
import { getApiBaseUrl } from "./config";

// anki-mcp's enriched user: the DB-owned fields the id_token never carried.
// `role` gates ProtectedRoute; `id` (DB id, ≠ Keycloak sub) is shown in Settings.
export interface AppUser extends OidcUser { id: string; role: string; avatar?: string }

export const authClient = createBffAuth<AppUser>({
  baseUrl: () => getApiBaseUrl(),          // runtime config thunk (config.ts stays)
  endpoints: {
    login: "/api/auth/login",
    callback: "/api/auth/callback",
    refresh: "/api/auth/refresh",
    logout: "/api/auth/logout",
  },
  // The callback `user` JSON already matches AppUser, so no mapCallbackUser needed
  // — it's stored AS-IS and surfaced through useUser<AppUser>() fully typed.
  // loginMode "fetch" (default) matches the current GET-login → {url,state} flow.
  // verifyState true (default) matches the localStorage("oauth_state") CSRF check.
  // expirySkewSeconds 30 (default) matches secure-storage's `expiresIn - 30`.
  // retry { retries: 1, delayMs: 1000 } (default) matches websocket/index.ts.
});
```

### After — the shrunk `apps/web/src/lib/websocket/index.ts` (~30 lines)

```ts
import { createOrpcWsClient } from "@orpc-ws/client";
import type { appContract } from "@repo/orpc-contract";
import { authClient } from "../auth";
import { getWsUrl } from "../config";
import { handleAuthFailure } from "../auth-failure";

export const wsClient = createOrpcWsClient<typeof appContract>({
  url: getWsUrl(),
  tokenProvider: authClient.tokenProvider,   // ← the seam; no app-side adapter
  onTerminalAuthFailure: () => handleAuthFailure(),
});

export const orpcClient = wsClient.rpc;

// Self-connect on load if a token already exists (preserves legacy auto-init).
if (authClient.getAuthStatus() !== "anonymous") wsClient.connect();
```

The clean boundary is now visible: the app declares **URLs + redirect policy**
(`auth-failure.ts`) and **runtime config** (`config.ts`) — nothing else. No
token storage, no refresh classification, no single-flight, no CSRF math, no
reactive store.

### `login.tsx` / `callback.tsx` after (sketch)

```tsx
// login.tsx — keep the JSX, swap the handler:
const handleSignIn = () => { setLoading(true); void authClient.redirectToLogin(); };

// callback.tsx — keep the spinner, swap the effect:
const { status, error } = useOidcCallback(authClient, { onSuccess: () => navigate("/") });
if (status === "error") navigate(`/login?error=${error?.type}`);
```

> **`NO TOKEN-STORAGE MIGRATION` (constraint 6).** The owner accepts existing
> users re-login on rollout. The app switches to the library's storage keys
> (`orpc-ws.bff.tokens`, single JSON blob, plus the sibling
> `orpc-ws.bff.tokens.user` for the canonical callback user); the legacy keys
> (`access_token`, `refresh_token`, `id_token`, `expires_at`, `user`,
> `oauth_state`) are simply abandoned. No `migrateLegacyTokens` helper is
> designed. Optionally the app can fire a one-time `localStorage.removeItem`
> sweep for the old keys; not required.

---

## G. Demo — `apps/demo-bff-bearer` (NEW)

No demo covers the browser-bearer-localStorage BFF variant
(`demo-backend-token` keeps the refresh token server-side; `demo-cookie-bff`
is cookie auth). Add one, mirroring `demo-backend-token`'s three-package
layout (`contract/`, `server/`, `client/`).

```
apps/demo-bff-bearer/
├── contract/   # shared ORPC contract (copy demo-backend-token/contract)
├── server/     # NestJS BFF: /auth/login → {url,state}; /auth/callback {code,state}
│               #   → { accessToken, refreshToken, idToken, expiresIn, user };
│               #   the `user` is the canonical identity (demo enriches it with
│               #   a fake `role`/`id` to mirror anki-mcp's DB enrichment);
│               #   /auth/refresh {refreshToken} → { accessToken, refreshToken?, expiresIn };
│               #   /auth/logout {idToken?} → { logoutUrl }.  Stateless proxy —
│               #   holds NO session; both tokens go to the browser. (This is
│               #   the anki-mcp shape, the opposite of demo-backend-token's
│               #   server-held refresh token.)
└── client/     # SPA: imports @orpc-ws/oidc-bff + @orpc-ws/oidc-react + @orpc-ws/client.
    └── src/lib/auth.ts   # ~15-line createBffAuth call (the §F example)
```

What it demonstrates:

- a consumer with **zero hand-written auth** — `createBffAuth` + `useAuthState`
  + `RequireAuth` + `useOidcCallback`, no app-side token/refresh/CSRF code;
- the browser-bearer model (both tokens in `localStorage`) end-to-end;
- the **canonical callback user**: the server returns a `user` with a `role`/`id`
  not present in the id_token, the client persists it (sibling user key) and
  surfaces it typed via `createBffAuth<DemoUser>` + `useUser<DemoUser>()`,
  proving the BFF-identity-authority path and its survival across refresh;
- the transient-retry + single-flight refresh path (server can be made to
  return a 503 to exercise it);
- `loginMode: "fetch"` + `verifyState: true` (the anki-mcp defaults);
- cross-tab logout sync (open two tabs, log out in one).

Wire it into `tests-e2e/` alongside the existing demo specs (Playwright)
for parity, if the owner wants e2e coverage of the topology.

---

## H. Phased rollout

### L1 — extract `oidc-core` (non-breaking)

- Create `packages/oidc-core`; move the topology-agnostic files (§C table)
  out of `oidc-pkce` (store, view, jwt, storage, format-callback-error, value
  types, new `AuthClient<TUser>`). The move also makes `AuthSnapshot` generic
  and adds the injected `resolveUser` strategy to `createAuthView` — both with
  `OidcUser`/id-token defaults, so `oidc-pkce` behavior is unchanged.
- `oidc-pkce` re-exports everything from core (§C shim); add the
  `AuthClient`-satisfaction type-test in `oidc-pkce`.
- Repoint `@orpc-ws/oidc-react` from `OidcAuth` (oidc-pkce) to `AuthClient`
  (oidc-core); flip its dep.
- Move `oidc-pkce`'s existing store/view/jwt unit tests to `oidc-core`
  (they test code that now lives there); leave `oidc-pkce`'s composition-root
  tests in place.
- One **changeset** (`minor`). Whole fixed group bumps. Still non-breaking
  (purely additive public surface).

### L2 — add `oidc-bff` + demo + tests

- Create `packages/oidc-bff` (`client.ts`, `refresh.ts`, `flow.ts`,
  `user-store.ts`, `endpoints.ts`, `types.ts`).
- Add `apps/demo-bff-bearer` (§G).
- **Vitest unit tests for the classification matrix** (`refresh.test.ts`),
  clock + fetch faked (the repo's `vitest.config.base.ts` already fakes
  `Date`):
  - 401 / 400 → `terminal` (→ `refresh()` returns `null`);
  - 5xx / 429 / 408 / 425 → `transient`;
  - fetch-throw → `transient`;
  - 2xx-but-garbage-body → `transient`;
  - missing refresh token in storage → `terminal`;
  - **retry-once**: first attempt `transient`, second `refreshed` → returns
    the token after exactly one `delayMs` wait; first + second both transient
    → `null` after one retry (bounded, no loop);
  - **single-flight**: two concurrent `refresh()` calls share one fetch;
  - `flow.handleCallback` state-mismatch / missing-code / idp-error / 2xx
    happy path; `redirectToLogin` fetch-mode persists state.
  - **canonical user**: `handleCallback` persists the server `user` (sibling
    key) and `getUser()` returns it verbatim (incl. fields the id_token lacks);
    `mapCallbackUser` reshapes when supplied; `refresh()` leaves the stored
    user intact (refresh returns no user); `clearTokens()`/`logout` wipe BOTH
    keys and fire the cross-tab `'storage'` event.
- Publish: `pnpm changeset version` → `0.4.0` for the whole fixed group →
  commit → release.

### A1 — consumer swap (separate PR in `anki-mcp-saas`, AFTER publish)

- Bump `@orpc-ws/*` to `0.4.0` in `apps/web`.
- Apply §F: delete the 5 files, shrink the 4, add the ~15-line `auth.ts`.
- Run the app's existing e2e (`tests/e2e`) — login, refresh-on-expiry,
  logout, cross-tab.

### Risks

- **Re-login on rollout** (constraint 6) — accepted; flag in release notes.
- **`fixed` group bumps everything to 0.4.0** — every published package gets a
  version bump even though only auth packages changed. Expected with the
  fixed-version policy; nothing to mitigate.
- **id-token-derived `user` vs server `user`** — **RESOLVED by design (not an
  open risk).** Verification against `anki-mcp` confirmed the callback `user`
  carries DB-owned fields absent from the id_token — `role` (roles map to the
  access token, not the id_token; read by the `ProtectedRoute` guard) and the
  DB `id` (≠ Keycloak `sub`; read by Settings). The design therefore makes the
  **callback response canonical** for BFF (persisted + returned as-is, generic
  over `TUser`), uses the id_token only for expiry, and provides
  `mapCallbackUser` as the shape-adapter escape hatch. `oidc-pkce` is
  unchanged (id-token-derived). No residual UI data-loss risk.
- **oidc-react repoint touches a published package's signatures** — type-only,
  structurally compatible, but re-run `oidc-react`'s tests (its `fake-auth.ts`
  test double must satisfy `AuthClient`; widen it if it only had the methods
  the old `OidcAuth`-typed hooks used).

---

## I. Forward-compat — the future server-side-refresh model

Constraint 7. The pluggable `Storage` seam (constraint 2) is what makes the
*next* topology a config swap, not a rewrite.

Today (browser-bearer): `createBffAuth` uses the default
`createLocalStorage("orpc-ws.bff.tokens")` — both tokens in `localStorage`,
`refresh()` POSTs the **refresh token** to `/api/auth/refresh`.

Future (server-held refresh token + httpOnly cookie session — the
`demo-backend-token` shape): the **only** things that change are *where tokens
live* and *what `refresh()` sends*:

- The browser keeps **only** a short-lived access token (in memory). A storage
  strategy `createSessionBackedStorage()` would back `read()/write()` with an
  in-memory cell and treat the httpOnly `sid` cookie as the durable session.
- `refresh()` POSTs **nothing** (the cookie carries the session); the server
  reads its stored refresh token and returns a new access token. This is a
  small variant of `refresh.ts` keyed off a `mode: "server-session"` flag —
  OR a sibling package `@orpc-ws/oidc-bff-session` that reuses `oidc-core` and
  most of `oidc-bff/flow.ts`.

Either way the consumer's call shape barely moves:

```ts
// today
export const authClient = createBffAuth({ baseUrl, endpoints });
// future — same endpoints, swap the storage/refresh strategy:
export const authClient = createBffAuth({ baseUrl, endpoints, storage: createSessionBackedStorage() });
```

Because `createAuthStore` already disables cross-tab wiring for non-default
storage (`storageKey: null` — see core `auth-store.ts`), an in-memory
session-backed storage drops into the existing wiring with no store changes.
This is the justification for paying the pluggable-storage cost **now**.

---

## J. Open decisions for the owner

- **Package name:** `@orpc-ws/oidc-bff` vs `@orpc-ws/oidc-backend-token`.
  `oidc-bff` is broader (covers the whole browser-bearer BFF shape, leaves
  room for the session variant); `oidc-backend-token` mirrors the existing
  demo name. **Recommend `oidc-bff`.**
- **`loginMode` default:** recommend **`"fetch"`** to match `anki-mcp`'s
  current GET-login-→-`{url,state}` flow (zero-change migration). `"redirect"`
  is there for server-state-cookie apps like `demo-backend-token`.
- **Demo name:** `apps/demo-bff-bearer` vs `apps/demo-browser-bearer` vs
  `apps/demo-bff`. Recommend `demo-bff-bearer` (distinguishes it from a
  future session demo).
- **Ship `oidc-react`'s narrowing (→ `AuthClient`) in the same 0.4.0 minor?**
  Recommend **yes** — it's type-only and non-breaking, and `oidc-bff` is
  useless with the React hooks until the hooks accept `AuthClient`. Splitting
  it into a later minor would leave BFF consumers hand-writing hooks in the
  interim.
- **Server `user` blob vs id-token-derived user — DECIDED.** Verification
  confirmed `anki-mcp`'s `/api/auth/callback` `user` DOES carry claims the
  id_token lacks (DB `id`, `role`). So for BFF the **callback response is
  canonical**: `handleCallback` persists and returns the server `user` as-is
  (generic `TUser`), the id_token is used only for expiry, and the optional
  `mapCallbackUser?(raw): TUser` on `BffAuthConfig` is the escape hatch for
  reshaping the JSON. `oidc-pkce` keeps deriving its user from the id_token
  (no backend to ask) via `createAuthView`'s default `resolveUser`.
```
