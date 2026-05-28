// Composition root for the demo SPA's OIDC auth.
//
// The entire PKCE / discovery / storage / refresh dance lives in
// `@repo/oidc-pkce`; this file is just the binding of runtime config
// to the library. Single module-level instance — every page imports
// the same `authClient`.

import { createOidcAuth } from "@repo/oidc-pkce";

import { config } from "./config.js";

export const authClient = createOidcAuth({
  issuerUrl: config.OIDC_ISSUER_URL,
  clientId: config.OIDC_CLIENT_ID,
  redirectUri: `${window.location.origin}/auth/callback`,
  scopes: ["openid", "email", "profile"],
});
