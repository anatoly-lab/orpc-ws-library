# @orpc-ws/react

## 0.6.0

### Patch Changes

- @orpc-ws/client@0.6.0

## 0.5.0

### Patch Changes

- @orpc-ws/client@0.5.0

## 0.4.0

### Patch Changes

- @orpc-ws/client@0.4.0

## 0.3.0

### Patch Changes

- @orpc-ws/client@0.3.0

## 0.2.1

### Patch Changes

- Republish to fix a broken `@orpc-ws/react@0.2.0` manifest. In 0.2.0 the
  package's `@orpc-ws/client` dependency was published as the literal pnpm
  `workspace:*` protocol spec instead of the resolved exact version, because that
  one package was bootstrapped (first-ever publish) with `npm publish` — and
  `npm` does not understand or rewrite the pnpm `workspace:*` protocol, so it
  shipped the string verbatim (an invalid range on the npm registry). 0.2.1 is
  published via `pnpm -r publish`, which rewrites `workspace:*` to the exact
  version. Consumers on `@orpc-ws/react@0.2.0` should upgrade to 0.2.1.
  - @orpc-ws/client@0.2.1

## 0.2.0

### Minor Changes

- c7da1fe: Extract WebSocket-transport React hooks (`useConnectionState`, `useWsSubscription`, `OrpcWsProvider`, `useOrpcWs`) into a new `@orpc-ws/react` package that depends only on `@orpc-ws/client`. `@orpc-ws/oidc-react` now hosts OIDC auth bindings only and no longer depends on `@orpc-ws/client`; import the WS hooks from `@orpc-ws/react` instead.

### Patch Changes

- @orpc-ws/client@0.2.0
