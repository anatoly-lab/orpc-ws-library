// Callback page — Keycloak redirects here with `?code=...&state=...`.
// We invoke authClient.handleCallback() once on mount, then navigate
// back to `/`.
//
// React StrictMode runs effects twice in dev. handleCallback is NOT
// idempotent (it consumes the PKCE verifier/state on read). The ref
// guard below ensures the second StrictMode invocation is a no-op.

import { useEffect, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";

import type { CallbackError } from "@repo/oidc-pkce";

import { authClient, wsClient } from "../lib/ws-client.js";

export function Callback(): ReactElement {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void (async () => {
      const params = new URLSearchParams(window.location.search);
      const result = await authClient.handleCallback(params);
      if (!result.ok) {
        setError(formatCallbackError(result.error));
        return;
      }
      wsClient.connect();
      navigate("/", { replace: true });
    })();
  }, [navigate]);

  return (
    <main style={{ maxWidth: 600, margin: "2rem auto", padding: "1rem" }}>
      <h1>Signing you in...</h1>
      {error && (
        <pre data-testid="callback-error" style={{ color: "red" }}>{error}</pre>
      )}
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
