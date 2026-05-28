// Public surface of `@repo/oidc-pkce`.
//
// Single composition root + named types. No re-exports from internal
// modules; consumers depend on the entry point only.

export { createOidcAuth, type OidcAuth } from "./client.js";

export {
  OidcDiscoveryError,
  type AuthStatus,
  type CallbackError,
  type CallbackResult,
  type OidcConfig,
  type OidcMetadata,
  type OidcUser,
  type Storage,
  type TokenProvider,
  type Tokens,
} from "./types.js";
