// Public surface of @repo/orpc-ws-oidc-react.
//
// This package exposes ONLY the library's React bindings (hooks + provider).
// The framework-free APIs are imported DIRECTLY from the cores —
// `@repo/orpc-ws-client` (transport) and `@repo/oidc-pkce` (auth) — not
// re-exported here.
//
// Why: it keeps the layering honest in a framework-agnostic library. This
// package stays thin and obviously-React, so a reader can tell at a glance
// what is React-specific versus core. Future svelte/vue/solid adapters follow
// the same rule, and consumers never reach core APIs "through" the React layer.
//
export { useConnectionState, OrpcWsProvider, useOrpcWs } from "./ws/index.js";
export type { OrpcWsProviderProps } from "./ws/index.js";

export { useAuthState, useUser } from "./oidc/index.js";
