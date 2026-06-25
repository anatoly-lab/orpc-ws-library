---
"@orpc-ws/cookie-bff": minor
"@orpc-ws/cookie-bff-nestjs": minor
---

Four additive (non-breaking) cookie-BFF enhancements:

- **WS lifecycle hooks through the Nest adapter** — `CookieBffModuleOptions` accepts `hooks?: AuthenticatedHooks<TUser>` (`onConnected`/`onDisconnected`/`onKicked`/`onZombieTerminated`), forwarded to the internal `OrpcWsModule`.
- **Auth-flow event seam** — `CookieBffOptions.authEvents?` (`onLoginStart` / `onCallbackSuccess(user)` / `onCallbackFailure(reason)` / `onLogout(sub)`). Fire-and-forget metrics hooks; a throwing hook is logged and never breaks the auth flow. (Forwarded automatically by the Nest adapter via the core options.)
- **Raw id_token claims to `resolveUser`** — `resolveUser(claims, tokens, rawClaims)` now receives the full decoded id_token payload as a third arg, so a trusted consumer can read ANY claim without a library release. The library still stores ONLY what `resolveUser` returns (no auto-spread of untrusted JSON). Also adds the standard `picture` claim to the typed `IdTokenClaims` and a new `decodeIdToken` helper returning `{ claims, raw }`.
- **Generic authorize params** — `keycloak.authorizeParams?: Record<string, string>` merges extra query params (`prompt`, `login_hint`, `max_age`, …) into the authorize URL. Applied before the 7 security-critical params, which always win — a consumer cannot clobber the PKCE / state / redirect / scope params.
