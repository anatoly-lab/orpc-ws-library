# @orpc-ws/cookie-bff-nestjs

## 0.4.0

### Minor Changes

- 28fbce5: Add cookie-BFF packages: framework-free server core + NestJS adapter (server-side session, httpOnly sid, OIDC PKCE, lazy refresh, revocation, synchronizer-token CSRF / Origin / \_\_Host- hardening) and a framework-free browser client core for the `/auth/*` control plane (typed `/auth/me`, in-memory synchronizer-CSRF token, CSRF-aware `mutate()`, login-URL builder, navigation-free `logout()`).

### Patch Changes

- Updated dependencies [28fbce5]
  - @orpc-ws/cookie-bff@0.4.0
  - @orpc-ws/shared@0.4.0
  - @orpc-ws/server@0.4.0
  - @orpc-ws/server-nestjs@0.4.0
