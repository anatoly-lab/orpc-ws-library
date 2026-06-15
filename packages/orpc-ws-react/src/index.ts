// React bindings for the ORPC-WS client core.
//
// Public surface of @orpc-ws/react — the WS-transport React adapter. Only the
// React-specific hooks/provider live here; the framework-free transport core
// is imported directly from `@orpc-ws/client`. Auth (OIDC) bindings live in
// the sibling `@orpc-ws/oidc-react` package, so this package has zero coupling
// to OIDC or any router.

export { useConnectionState } from "./use-connection-state.js";
export { OrpcWsProvider, useOrpcWs } from "./provider.js";
export type { OrpcWsProviderProps } from "./provider.js";
export { useWsSubscription } from "./use-ws-subscription.js";
export type {
  UseWsSubscriptionOptions,
  UseWsSubscriptionResult,
} from "./use-ws-subscription.js";
