// App-specific, friendly copy for OIDC callback failures.
//
// The library ships no per-variant error strings on purpose — error wording
// is an app concern (localization, tone, support links). This formatter is
// passed to <OidcCallback renderError={...}> to demonstrate that seam.

import type { CallbackError } from "@repo/oidc-pkce";

export function formatCallbackError(err: CallbackError): string {
  switch (err.type) {
    case "state_mismatch":
      return "OAuth state mismatch (possibly an old/replayed callback).";
    case "missing_code":
      return "Authorization code missing from callback URL.";
    case "exchange_failed":
      return `Token exchange failed: HTTP ${err.status}\n${err.body}`;
    case "idp_error":
      return `IdP error: ${err.error}${err.description ? "\n" + err.description : ""}`;
  }
}
