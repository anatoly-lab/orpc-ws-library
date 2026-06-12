// Public surface of `@orpc-ws/oidc-verifier-jose`.
//
// Single composition root + named types. No re-exports from internal
// modules; consumers depend on the entry point only.

export { createOidcVerifyClient } from "./client.js";

export {
  OidcDiscoveryError,
  type BoundClaim,
  type OidcMetadata,
  type OidcUser,
  type OidcVerifierConfig,
} from "./types.js";
