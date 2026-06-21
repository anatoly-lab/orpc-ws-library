// backend-token WS verify. Identical to PKCE: the access token still rides
// `?token=` to the WS and is cryptographically verified by
// `@orpc-ws/oidc-verifier-jose`. The ONLY difference from PKCE is WHERE the
// token comes from — in backend-token the SERVER mints it (via the
// /auth/token + /auth/refresh endpoints) and the SPA forwards it, whereas
// in PKCE the SPA mints it directly. The verify is the same either way
// (it's the same token, bound to the same SPA client), so this is a thin
// wrapper over the PKCE verifier to keep the mode self-contained.

import type { VerifyClient } from "@orpc-ws/server-nestjs";
import type { OidcUser } from "@orpc-ws/oidc-verifier-jose";

import type { OidcAuthConfig } from "../config.js";
import { createPkceVerifyClient } from "./pkce.verify.js";

export function createBackendTokenVerifyClient(
  oidc: OidcAuthConfig,
): VerifyClient<OidcUser> {
  return createPkceVerifyClient(oidc);
}
