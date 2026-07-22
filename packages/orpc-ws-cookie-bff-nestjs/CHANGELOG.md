# @orpc-ws/cookie-bff-nestjs

## 0.12.0

### Minor Changes

- BREAKING: `@orpc/client`, `@orpc/contract`, and `@orpc/server` are now peerDependencies (range `>=1.14.8 <2`) instead of dependencies. Consumers must declare these `@orpc/*` packages as direct dependencies at `>=1.14.8 <2`. This prevents two @orpc copies in one process — ORPC's version-keyed cross-copy `instanceof` shim would otherwise degrade typed ORPCErrors to a generic "Internal server error" when the consumer's @orpc version differs from the library's.

### Patch Changes

- Updated dependencies
  - @orpc-ws/shared@0.12.0
  - @orpc-ws/server@0.12.0
  - @orpc-ws/server-nestjs@0.12.0
  - @orpc-ws/cookie-bff@0.12.0

## 0.11.1

### Patch Changes

- chore: upgrade dependencies (no public API changes)
- Updated dependencies
  - @orpc-ws/shared@0.11.1
  - @orpc-ws/server@0.11.1
  - @orpc-ws/server-nestjs@0.11.1
  - @orpc-ws/cookie-bff@0.11.1

## 0.11.0

### Minor Changes

- 3cd8f23: Thread server→client RPC (bidirectional) through the cookie-BFF NestJS adapter.

  `CookieBffModule` now accepts an optional `clientContract` — the client's
  contract router — and forwards it unchanged into the internal `OrpcWsModule`.
  Its presence flips bidi on for cookie-authed connections, giving every
  connection a typed `conn.client` caller (in `hooks.onConnected` and via
  `OrpcWsService.getConnection(key)?.client`), exactly as the token/authless
  `@orpc-ws/server-nestjs` path already does. Additive: omit `clientContract`
  and the WS options are byte-identical to before (no `conn.client`).

  `CookieBffModuleOptions` / `CookieBffModuleAsyncOptions` gain two extra
  defaulted generics `<TUser, TContract, TClientContract>` (existing one-way
  configs compile unchanged); `hooks` is now `AuthenticatedHooks<TUser,
TClientContract>`. On `forRootAsync`, annotate the `useFactory` return type or
  `TClientContract` collapses to `never` and `conn.client` loses its typing
  (runtime still wires bidi). The adapter re-exports `AnyContractRouter` for the
  annotation.

### Patch Changes

- @orpc-ws/shared@0.11.0
- @orpc-ws/server@0.11.0
- @orpc-ws/server-nestjs@0.11.0
- @orpc-ws/cookie-bff@0.11.0

## 0.10.0

### Patch Changes

- 43d9547: Session-slide race fix and guaranteed revocation kick:

  - New optional `SessionStore.touch?(sid, sessionExpiresAt, { ttlSeconds })` seam method (express-session precedent): an expiry-only atomic update the sliding session window now prefers, closing the read-modify-write race where a slide's stale snapshot could roll back a concurrent token refresh (dead rotated refresh token → premature self-logout). Get/set-only stores fall back to a fresh re-read immediately before the write — the race window narrows but is not eliminated; implement `touch` for full safety. The fallback also no longer resurrects a session deleted since the caller's read.
  - `revokeUser` now guarantees the live-socket kick even when the store delete rejects (`finally`), while preserving delete-first ordering and propagating the store failure to the caller after the kick. A throwing consumer-supplied `closeUser` can no longer mask the delete rejection (new optional injected `logger` records kick failures; the NestJS adapter wires `options.logger` through).

- Updated dependencies [43d9547]
- Updated dependencies [80b5a72]
- Updated dependencies [63d12e8]
- Updated dependencies [074e1ae]
- Updated dependencies [ac70eb7]
- Updated dependencies [4782cab]
  - @orpc-ws/cookie-bff@0.10.0
  - @orpc-ws/server@0.10.0
  - @orpc-ws/server-nestjs@0.10.0
  - @orpc-ws/shared@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [654a03d]
  - @orpc-ws/server@0.9.0
  - @orpc-ws/server-nestjs@0.9.0
  - @orpc-ws/cookie-bff@0.9.0
  - @orpc-ws/shared@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [b93dd3d]
  - @orpc-ws/shared@0.8.0
  - @orpc-ws/server@0.8.0
  - @orpc-ws/server-nestjs@0.8.0
  - @orpc-ws/cookie-bff@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [9fa4fc8]
  - @orpc-ws/cookie-bff@0.7.0
  - @orpc-ws/shared@0.7.0
  - @orpc-ws/server@0.7.0
  - @orpc-ws/server-nestjs@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [094d2e8]
  - @orpc-ws/cookie-bff@0.6.1
  - @orpc-ws/shared@0.6.1
  - @orpc-ws/server@0.6.1
  - @orpc-ws/server-nestjs@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [ef68d30]
  - @orpc-ws/shared@0.6.0
  - @orpc-ws/cookie-bff@0.6.0
  - @orpc-ws/server@0.6.0
  - @orpc-ws/server-nestjs@0.6.0

## 0.5.0

### Minor Changes

- 2f6435f: Four additive (non-breaking) cookie-BFF enhancements:

  - **WS lifecycle hooks through the Nest adapter** — `CookieBffModuleOptions` accepts `hooks?: AuthenticatedHooks<TUser>` (`onConnected`/`onDisconnected`/`onKicked`/`onZombieTerminated`), forwarded to the internal `OrpcWsModule`.
  - **Auth-flow event seam** — `CookieBffOptions.authEvents?` (`onLoginStart` / `onCallbackSuccess(user)` / `onCallbackFailure(reason)` / `onLogout(sub)`). Fire-and-forget metrics hooks; a throwing hook is logged and never breaks the auth flow. (Forwarded automatically by the Nest adapter via the core options.)
  - **Raw id_token claims to `resolveUser`** — `resolveUser(claims, tokens, rawClaims)` now receives the full decoded id_token payload as a third arg, so a trusted consumer can read ANY claim without a library release. The library still stores ONLY what `resolveUser` returns (no auto-spread of untrusted JSON). Also adds the standard `picture` claim to the typed `IdTokenClaims` and a new `decodeIdToken` helper returning `{ claims, raw }`.
  - **Generic authorize params** — `keycloak.authorizeParams?: Record<string, string>` merges extra query params (`prompt`, `login_hint`, `max_age`, …) into the authorize URL. Applied before the 7 security-critical params, which always win — a consumer cannot clobber the PKCE / state / redirect / scope params.

### Patch Changes

- Updated dependencies [2f6435f]
  - @orpc-ws/cookie-bff@0.5.0
  - @orpc-ws/shared@0.5.0
  - @orpc-ws/server@0.5.0
  - @orpc-ws/server-nestjs@0.5.0

## 0.4.0

### Minor Changes

- 28fbce5: Add cookie-BFF packages: framework-free server core + NestJS adapter (server-side session, httpOnly sid, OIDC PKCE, lazy refresh, revocation, synchronizer-token CSRF / Origin / \_\_Host- hardening) and a framework-free browser client core for the `/auth/*` control plane (typed `/auth/me`, in-memory synchronizer-CSRF token, CSRF-aware `mutate()`, login-URL builder, navigation-free `logout()`).

### Patch Changes

- Updated dependencies [28fbce5]
  - @orpc-ws/cookie-bff@0.4.0
  - @orpc-ws/shared@0.4.0
  - @orpc-ws/server@0.4.0
  - @orpc-ws/server-nestjs@0.4.0
