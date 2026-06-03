// Callback page — Keycloak redirects here with `?code=...&state=...`.
//
// The exchange + StrictMode-once + navigation logic now lives in the library's
// `<OidcCallback>` (from the `@repo/orpc-ws-oidc-react/react-router` sub-path).
// This page keeps only the APP-specific bit: friendly per-variant error copy
// via `formatCallbackError`, passed through `renderError`. The library ships
// no error copy of its own — that's a deliberate app concern.

import type { ReactElement } from "react";

import type { CallbackError } from "@repo/oidc-pkce";
import { OidcCallback } from "@repo/orpc-ws-oidc-react/react-router";

import { authClient } from "../lib/ws-client.js";

export function Callback(): ReactElement {
  return (
    <main style={{ maxWidth: 600, margin: "2rem auto", padding: "1rem" }}>
      <OidcCallback
        client={authClient}
        navigateTo="/"
        fallback={<h1>Signing you in...</h1>}
        renderError={(error) => (
          <pre data-testid="callback-error" style={{ color: "red" }}>
            {formatCallbackError(error)}
          </pre>
        )}
      />
    </main>
  );
}

function formatCallbackError(err: CallbackError): string {
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
