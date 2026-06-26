---
"@orpc-ws/cookie-bff": patch
"@orpc-ws/oidc-verifier-jose": patch
---

Fix split-horizon OIDC. The cookie-BFF server-side token exchange and refresh now rewrite the discovery-advertised `token_endpoint` from the public issuer origin to the internal `discoveryUrl` origin when the two differ, so the back-channel token POST reaches the IdP from inside the network (previously it hit the unreachable public host → `fetch failed` on `/auth/callback`). Browser-facing endpoints (`authorization_endpoint`, `end_session_endpoint`) deliberately stay on the public host. Host matching is case-insensitive (RFC 3986) and opaque origins never match; it is a no-op for single-URL deployments. This mirrors — and hardens — the existing `jwks_uri` rewrite in `@orpc-ws/oidc-verifier-jose`, which gains the same case-insensitive / opaque-origin handling.
