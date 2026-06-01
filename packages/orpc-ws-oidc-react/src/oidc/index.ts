// React bindings for the OIDC-PKCE auth core.
//
// Thin barrel — groups the OIDC auth hooks under `oidc/` so they sit alongside
// the WS bindings in `ws/`. Only the React-specific hooks live here; the
// framework-free auth core (including `AuthSnapshot`) is imported directly
// from `@repo/oidc-pkce`.

export { useAuthState } from "./use-auth-state.js";
export { useUser } from "./use-user.js";
