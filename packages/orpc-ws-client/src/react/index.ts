// Public surface of @repo/orpc-ws-client/react (React adapter, Phase 2).
//
// Sub-path barrel — kept thin so the framework-free core stays untainted.
// The lint zone in `eslint.config.js` enforces that this directory is the
// only place under `packages/orpc-ws-client/src` that may import React.

export { useConnectionState } from "./use-connection-state.js";
export { OrpcWsProvider, useOrpcWs } from "./provider.js";
export type { OrpcWsProviderProps } from "./provider.js";
