# @orpc-ws/shared

## 0.6.1

## 0.6.0

### Minor Changes

- ef68d30: Remove the browser-PKCE / localStorage auth topology. `@orpc-ws/oidc-pkce` (browser PKCE core) and `@orpc-ws/oidc-react` (its React hooks adapter) are deleted from the library and deprecated on npm. Browsers should authenticate via cookie-BFF (`@orpc-ws/cookie-bff`, `-nestjs`, `-client`); native/mobile/service clients send a Bearer token over the WS and verify it server-side with `@orpc-ws/oidc-verifier-jose` (kept for exactly this path). `@orpc-ws/react` is now the sole React adapter. The `apps/demo-pkce` app was removed and the Playwright e2e suite was repointed to the cookie-BFF demo. No source-level API change to any retained package — this is a topology/packaging change (the lockstep bump keeps the 9 retained packages in version sync).

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.1

## 0.2.0

## 0.1.2
