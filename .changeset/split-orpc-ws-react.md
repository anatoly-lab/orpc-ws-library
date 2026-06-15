---
"@orpc-ws/react": minor
"@orpc-ws/oidc-react": minor
---

Extract WebSocket-transport React hooks (`useConnectionState`, `useWsSubscription`, `OrpcWsProvider`, `useOrpcWs`) into a new `@orpc-ws/react` package that depends only on `@orpc-ws/client`. `@orpc-ws/oidc-react` now hosts OIDC auth bindings only and no longer depends on `@orpc-ws/client`; import the WS hooks from `@orpc-ws/react` instead.
