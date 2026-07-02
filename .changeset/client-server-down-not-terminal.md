---
"@orpc-ws/client": patch
---

A server that is merely down no longer forces a logout (token mode). Pre-open connection failures — which the browser cannot distinguish from handshake rejections — now trip the storm guard to *keep retrying with the current token* (riding the reconnect backoff, one token refresh per 30s window) instead of firing `onTerminalAuthFailure` within ~30s of downtime. Give-up stays auth-owned: a failed/null refresh, a real post-accept auth close (1008/4001), or an upload 401 still goes terminal. Corollary (documented): a handshake-time rejection by the server is indistinguishable from downtime in the browser and also retries — servers wanting a hard client give-up must reject after accepting (1008/4001 close).
