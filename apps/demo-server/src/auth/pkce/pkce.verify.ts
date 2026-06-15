// PKCE-mode WS verify: the SPA performs the OIDC dance and forwards the
// access token via `?token=`. The server cryptographically verifies that
// token with `@orpc-ws/oidc-verifier-jose` — this is the original
// single-mode demo's verifier, extracted verbatim.
//
// `boundClaim: "azp"` is the Keycloak default — the token is minted for the
// SPA's public client (`expectedClientId`). Auth0 / Okta consumers would
// set `"aud"`.

import { createOidcVerifyClient } from "@orpc-ws/oidc-verifier-jose";
import type { VerifyClient } from "@orpc-ws/server-nestjs";
import type { OidcUser } from "@orpc-ws/oidc-verifier-jose";

import type { OidcAuthConfig } from "../../config.js";

export function createPkceVerifyClient(
  oidc: OidcAuthConfig,
): VerifyClient<OidcUser> {
  return createOidcVerifyClient({
    issuerUrl: oidc.issuerUrl,
    // Split-host (container) deployments fetch discovery + JWKS over the
    // internal docker-network URL while validating the token `iss` against
    // the public `issuerUrl`. Omitted in local dev ⇒ verifier defaults to
    // issuerUrl.
    ...(oidc.discoveryUrl ? { discoveryUrl: oidc.discoveryUrl } : {}),
    boundClaim: "azp",
    expectedClientId: oidc.clientId,
  });
}
