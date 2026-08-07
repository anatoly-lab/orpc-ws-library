# @orpc-ws/cookie-bff-client

## 0.12.1

### Patch Changes

- chore: upgrade dependencies (no public API changes)

## 0.12.0

### Minor Changes

- BREAKING: `@orpc/client`, `@orpc/contract`, and `@orpc/server` are now peerDependencies (range `>=1.14.8 <2`) instead of dependencies. Consumers must declare these `@orpc/*` packages as direct dependencies at `>=1.14.8 <2`. This prevents two @orpc copies in one process — ORPC's version-keyed cross-copy `instanceof` shim would otherwise degrade typed ORPCErrors to a generic "Internal server error" when the consumer's @orpc version differs from the library's.

## 0.11.1

### Patch Changes

- chore: upgrade dependencies (no public API changes)

## 0.11.0

## 0.10.0

## 0.9.0

## 0.8.0

## 0.7.0

## 0.6.1

## 0.6.0

## 0.5.0

## 0.4.0

### Minor Changes

- 28fbce5: Add cookie-BFF packages: framework-free server core + NestJS adapter (server-side session, httpOnly sid, OIDC PKCE, lazy refresh, revocation, synchronizer-token CSRF / Origin / \_\_Host- hardening) and a framework-free browser client core for the `/auth/*` control plane (typed `/auth/me`, in-memory synchronizer-CSRF token, CSRF-aware `mutate()`, login-URL builder, navigation-free `logout()`).
