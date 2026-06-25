# @orpc-ws/oidc-react

## 0.5.0

### Patch Changes

- @orpc-ws/oidc-pkce@0.5.0

## 0.4.0

### Patch Changes

- @orpc-ws/oidc-pkce@0.4.0

## 0.3.0

### Patch Changes

- @orpc-ws/oidc-pkce@0.3.0

## 0.2.1

### Patch Changes

- @orpc-ws/oidc-pkce@0.2.1

## 0.2.0

### Minor Changes

- 38271ba: The `./react-router` sub-path's optional peer dependency is now
  `react-router` (range `>=7.0.0`) instead of the removed `react-router-dom`.
  React Router v7 merged the former `react-router-dom` DOM bindings into the
  main `react-router` package; `react-router-dom` is a deprecated re-export
  shim that v8 removes. The `OidcCallback` component now imports `useNavigate`
  from `react-router`. Consumers of the sub-path should depend on
  `react-router` (v7 or v8) rather than `react-router-dom`; the main entry is
  unaffected (it has no router dependency).

  Also raises the published cores' `engines.node` 22-line floor from
  `>=22.12.0` to `>=22.22.0` (the range is now `^20.19.0 || >=22.22.0`),
  matching react-router v8's `engines.node` requirement. Node 20.19+ support
  is retained.

- c7da1fe: Extract WebSocket-transport React hooks (`useConnectionState`, `useWsSubscription`, `OrpcWsProvider`, `useOrpcWs`) into a new `@orpc-ws/react` package that depends only on `@orpc-ws/client`. `@orpc-ws/oidc-react` now hosts OIDC auth bindings only and no longer depends on `@orpc-ws/client`; import the WS hooks from `@orpc-ws/react` instead.

### Patch Changes

- @orpc-ws/oidc-pkce@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [9e44221]
  - @orpc-ws/client@0.1.2
  - @orpc-ws/oidc-pkce@0.1.2
