# @orpc-ws/react

## 0.2.0

### Minor Changes

- c7da1fe: Extract WebSocket-transport React hooks (`useConnectionState`, `useWsSubscription`, `OrpcWsProvider`, `useOrpcWs`) into a new `@orpc-ws/react` package that depends only on `@orpc-ws/client`. `@orpc-ws/oidc-react` now hosts OIDC auth bindings only and no longer depends on `@orpc-ws/client`; import the WS hooks from `@orpc-ws/react` instead.

### Patch Changes

- @orpc-ws/client@0.2.0
