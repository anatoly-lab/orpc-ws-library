---
"@orpc-ws/react": minor
---

React adapter fixes for reconnect blips and stream lifecycle:

- `<OrpcWs>`'s `fallback` now latches after the first successful connect: children stay mounted through reconnect blips (previously every disconnect unmounted the whole subtree, losing component state, unregistering `useServerHandler` handlers, and resetting subscriptions). Observe blips via `useConnectionState`.
- `useWsSubscription` gains a `"completed"` status: a finite stream ending gracefully is now observable instead of leaving `status` stuck at `"active"` forever. Sticky until the next reconnect cycle or `enabled` toggle.
- `useWsSubscription` hardening: a late event racing teardown can no longer corrupt `status` or reach a disabled consumer (abort guard in `onEvent`), and a rejecting iterator `return()` during teardown no longer escapes as an unhandled rejection.
