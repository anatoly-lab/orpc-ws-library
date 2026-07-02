---
"@orpc-ws/server": minor
---

Two hardening changes (user-approved 2026-07-02):

- **Heartbeat subscriptions are now last-wins per connection.** One socket could previously open unbounded heartbeat streams (each allocating server-side machinery freed only at disconnect — an unauthenticated memory-growth vector on authless servers). Now a new heartbeat subscription on the same connection gracefully ends the previous one, strictly bounding it at 1 per connection. The library's own client always aborts before resubscribing, so legitimate clients are unaffected. `subscriberCount()` now reports the true live-subscriber count (it previously counted distinct event names — always 0 or 1).
- **New `verifyTimeoutMs` option (default 30000, `0` or negative disables).** A consumer `verifyClient` promise that never settles (e.g. a stuck JWKS fetch with no timeout of its own) previously pinned the pending upgrade socket forever. The verify is now raced against a deadline on the injected `Clock`; on timeout the upgrade fails closed (pre-101 HTTP 500) and the late settlement is ignored. Not applicable to authless mode. `DEFAULT_VERIFY_TIMEOUT_MS` is exported.
