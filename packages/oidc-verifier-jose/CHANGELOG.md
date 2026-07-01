# @orpc-ws/oidc-verifier-jose

## 0.9.0

### Patch Changes

- Updated dependencies [654a03d]
  - @orpc-ws/server@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [b93dd3d]
  - @orpc-ws/server@0.8.0

## 0.7.0

### Patch Changes

- @orpc-ws/server@0.7.0

## 0.6.1

### Patch Changes

- 094d2e8: Fix split-horizon OIDC. The cookie-BFF server-side token exchange and refresh now rewrite the discovery-advertised `token_endpoint` from the public issuer origin to the internal `discoveryUrl` origin when the two differ, so the back-channel token POST reaches the IdP from inside the network (previously it hit the unreachable public host → `fetch failed` on `/auth/callback`). Browser-facing endpoints (`authorization_endpoint`, `end_session_endpoint`) deliberately stay on the public host. Host matching is case-insensitive (RFC 3986) and opaque origins never match; it is a no-op for single-URL deployments. This mirrors — and hardens — the existing `jwks_uri` rewrite in `@orpc-ws/oidc-verifier-jose`, which gains the same case-insensitive / opaque-origin handling.
  - @orpc-ws/server@0.6.1

## 0.6.0

### Patch Changes

- @orpc-ws/server@0.6.0

## 0.5.0

### Patch Changes

- @orpc-ws/server@0.5.0

## 0.4.0

### Patch Changes

- @orpc-ws/server@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [d02786d]
  - @orpc-ws/server@0.3.0

## 0.2.1

### Patch Changes

- @orpc-ws/server@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [f6a8a17]
  - @orpc-ws/server@0.2.0

## 0.1.2

### Patch Changes

- @orpc-ws/server@0.1.2
