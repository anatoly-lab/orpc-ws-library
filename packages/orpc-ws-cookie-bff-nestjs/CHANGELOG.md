# @orpc-ws/cookie-bff-nestjs

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
