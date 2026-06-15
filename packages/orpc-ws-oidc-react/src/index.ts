// Public surface of @orpc-ws/oidc-react.
//
// This package exposes ONLY the library's OIDC React bindings (auth hooks +
// RequireAuth). The framework-free auth API is imported DIRECTLY from the
// `@orpc-ws/oidc-pkce` core — not re-exported here. The WS-transport React
// bindings (useConnectionState, useWsSubscription, OrpcWsProvider, useOrpcWs)
// now live in the sibling `@orpc-ws/react` package; import them from there.
//
// Why: it keeps the layering honest in a framework-agnostic library. This
// package stays thin and obviously-React, so a reader can tell at a glance
// what is React-specific versus core. Future svelte/vue/solid adapters follow
// the same rule, and consumers never reach core APIs "through" the React layer.
//
export { useAuthState, useUser, useOidcCallback, RequireAuth } from "./oidc/index.js";
export type {
  UseOidcCallbackOptions,
  UseOidcCallbackResult,
  RequireAuthProps,
} from "./oidc/index.js";
