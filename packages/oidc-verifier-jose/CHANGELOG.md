# @orpc-ws/oidc-verifier-jose

## 0.13.0

### Patch Changes

- @orpc-ws/server@0.13.0

## 0.12.3

### Patch Changes

- chore: build with TypeScript 7 (Go-native compiler). Shipped declarations verified byte-identical to the TS 6 build — no public API or behavior changes.
- Updated dependencies
  - @orpc-ws/server@0.12.3

## 0.12.2

### Patch Changes

- chore: migrate lint tooling from ESLint to Biome (type-import style normalization only — no public API or behavior changes)
- Updated dependencies
  - @orpc-ws/server@0.12.2

## 0.12.1

### Patch Changes

- chore: upgrade dependencies (no public API changes)
- Updated dependencies
  - @orpc-ws/server@0.12.1

## 0.12.0

### Minor Changes

- BREAKING: `@orpc/client`, `@orpc/contract`, and `@orpc/server` are now peerDependencies (range `>=1.14.8 <2`) instead of dependencies. Consumers must declare these `@orpc/*` packages as direct dependencies at `>=1.14.8 <2`. This prevents two @orpc copies in one process — ORPC's version-keyed cross-copy `instanceof` shim would otherwise degrade typed ORPCErrors to a generic "Internal server error" when the consumer's @orpc version differs from the library's.

### Patch Changes

- Updated dependencies
  - @orpc-ws/server@0.12.0

## 0.11.1

### Patch Changes

- chore: upgrade dependencies (no public API changes)
- Updated dependencies
  - @orpc-ws/server@0.11.1

## 0.11.0

### Patch Changes

- @orpc-ws/server@0.11.0

## 0.10.0

### Minor Changes

- 80b5a72: Low-severity hardening batch:

  - **client**: `upload()` now rejects before any I/O once the client is dead (disposed, terminal auth failure, or kicked) — previously a post-`dispose()` upload performed a real network call and could emit events. The bidi handle is now retired on terminal/kicked paths (was: only on `dispose()`, a memory retention). New public `LinkNotReadyError` typed error thrown by the link factory when the socket isn't open. Heartbeat subscriber no longer retains the last loop's closure.
  - **react**: `useWsSubscription` classifies `LinkNotReadyError` as transient — the narrow drop-between-render-and-subscribe race no longer flashes `status: "error"`; it self-heals silently on reconnect.
  - **server**: upload HTTP handler reuses the shared client-IP extraction (fixing an X-Forwarded-For empty-first-hop drift with the WS path) and restores `req.url`/`req.originalUrl` before delegating unmatched requests via `next()`. The shared verify-result guard now also rejects `{ok: true, user: undefined}` (both transports).
  - **oidc-verifier-jose**: `jwtVerify` now pins an explicit `algorithms` allowlist. **Default-pinning behavior change**: the default set is the asymmetric algorithms `RS256/384/512, ES256/384/512, PS256/384/512, EdDSA` — symmetric (`HS*`) tokens are now rejected before key resolution (RS→HS key-confusion defense). If your IdP signs with an algorithm outside this set, pass `algorithms: [...]` explicitly. New `clockTolerance` option (exp/nbf skew), off by default.

### Patch Changes

- Updated dependencies [80b5a72]
- Updated dependencies [63d12e8]
- Updated dependencies [ac70eb7]
- Updated dependencies [4782cab]
  - @orpc-ws/server@0.10.0

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
