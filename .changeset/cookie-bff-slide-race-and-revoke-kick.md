---
"@orpc-ws/cookie-bff": minor
"@orpc-ws/cookie-bff-nestjs": patch
---

Session-slide race fix and guaranteed revocation kick:

- New optional `SessionStore.touch?(sid, sessionExpiresAt, { ttlSeconds })` seam method (express-session precedent): an expiry-only atomic update the sliding session window now prefers, closing the read-modify-write race where a slide's stale snapshot could roll back a concurrent token refresh (dead rotated refresh token → premature self-logout). Get/set-only stores fall back to a fresh re-read immediately before the write — the race window narrows but is not eliminated; implement `touch` for full safety. The fallback also no longer resurrects a session deleted since the caller's read.
- `revokeUser` now guarantees the live-socket kick even when the store delete rejects (`finally`), while preserving delete-first ordering and propagating the store failure to the caller after the kick. A throwing consumer-supplied `closeUser` can no longer mask the delete rejection (new optional injected `logger` records kick failures; the NestJS adapter wires `options.logger` through).
