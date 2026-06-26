// React bindings for the ORPC-WS client core.
//
// Public surface of @orpc-ws/react — the sole React adapter, binding the
// WS-transport client core only. Only the React-specific hooks/provider live
// here; the framework-free transport core is imported directly from
// `@orpc-ws/client`. This package is WS-transport-only and exposes framework
// bindings only — it carries zero coupling to any auth core or router.

export { useConnectionState } from "./use-connection-state.js";
export { OrpcWsProvider, useOrpcWs } from "./provider.js";
export type { OrpcWsProviderProps } from "./provider.js";
export { useWsSubscription } from "./use-ws-subscription.js";
export type {
  UseWsSubscriptionOptions,
  UseWsSubscriptionResult,
} from "./use-ws-subscription.js";
