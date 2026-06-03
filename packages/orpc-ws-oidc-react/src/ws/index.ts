// React bindings for the ORPC-WS client core.
//
// Thin barrel — keeps the two hook/provider modules grouped under `ws/` so
// the `oidc/` react hooks can sit alongside without churn. Only the
// React-specific hooks/provider live here; the framework-free transport core
// is imported directly from `@repo/orpc-ws-client`.

export { useConnectionState } from "./use-connection-state.js";
export { OrpcWsProvider, useOrpcWs } from "./provider.js";
export type { OrpcWsProviderProps } from "./provider.js";
export { useWsSubscription } from "./use-ws-subscription.js";
export type {
  UseWsSubscriptionOptions,
  UseWsSubscriptionResult,
} from "./use-ws-subscription.js";
