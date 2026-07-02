---
"@orpc-ws/client": minor
"@orpc-ws/react": patch
"@orpc-ws/server": patch
"@orpc-ws/oidc-verifier-jose": minor
---

Low-severity hardening batch:

- **client**: `upload()` now rejects before any I/O once the client is dead (disposed, terminal auth failure, or kicked) — previously a post-`dispose()` upload performed a real network call and could emit events. The bidi handle is now retired on terminal/kicked paths (was: only on `dispose()`, a memory retention). New public `LinkNotReadyError` typed error thrown by the link factory when the socket isn't open. Heartbeat subscriber no longer retains the last loop's closure.
- **react**: `useWsSubscription` classifies `LinkNotReadyError` as transient — the narrow drop-between-render-and-subscribe race no longer flashes `status: "error"`; it self-heals silently on reconnect.
- **server**: upload HTTP handler reuses the shared client-IP extraction (fixing an X-Forwarded-For empty-first-hop drift with the WS path) and restores `req.url`/`req.originalUrl` before delegating unmatched requests via `next()`. The shared verify-result guard now also rejects `{ok: true, user: undefined}` (both transports).
- **oidc-verifier-jose**: `jwtVerify` now pins an explicit `algorithms` allowlist. **Default-pinning behavior change**: the default set is the asymmetric algorithms `RS256/384/512, ES256/384/512, PS256/384/512, EdDSA` — symmetric (`HS*`) tokens are now rejected before key resolution (RS→HS key-confusion defense). If your IdP signs with an algorithm outside this set, pass `algorithms: [...]` explicitly. New `clockTolerance` option (exp/nbf skew), off by default.
