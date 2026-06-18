// React Router adapter — `<OidcCallback>` drop-in callback route component.
//
// The ergonomic Tier-2 surface: a 1-line `<Route element={<OidcCallback
// client={authClient} />} />` that handles the redirect-back exchange and
// navigates home on success. It REUSES `useOidcCallback` for all logic —
// this file only adds react-router's `useNavigate` wiring and minimal
// default UI. No exchange logic lives here, so the hook and the component
// can never diverge.
//
// react-router is an OPTIONAL peer of this package: it is dragged in only
// when a consumer imports `@orpc-ws/oidc-react/react-router`. The main
// entry (the `useOidcCallback` hook) stays router-free. Keeping the binding
// in a sub-path is what lets the core stay honestly framework-agnostic
// (CLAUDE.md sub-path rule: same browser runtime + peer-only dependency).
//
// react-router v7 merged the former react-router-dom DOM bindings into the
// main `react-router` package (react-router-dom is a deprecated shim that v8
// removes); `useNavigate` is a general API exported from `react-router`.

import type { ReactElement, ReactNode } from "react";
import { useNavigate } from "react-router";

import { formatCallbackError, type CallbackError, type OidcAuth } from "@orpc-ws/oidc-pkce";

import { useOidcCallback } from "../oidc/use-oidc-callback.js";

/** Props for {@link OidcCallback}. */
export interface OidcCallbackProps {
  /** The `OidcAuth` instance (from `createOidcAuth`). Stable across renders. */
  client: OidcAuth;
  /** Path to navigate to on success. Defaults to `"/"`. Uses `replace`. */
  navigateTo?: string;
  /**
   * Rendered while the exchange is pending (and while idle, if the route was
   * hit without IdP params). Defaults to a minimal "Signing you in…" line.
   */
  fallback?: ReactNode;
  /**
   * Render the error UI from the failure variant. Defaults to rendering
   * `formatCallbackError(error)` (the neutral, framework-free default copy
   * from `@orpc-ws/oidc-pkce`) inside a `<pre>`. Pass `renderError` to
   * localize/style/brand it — e.g. reuse the library string but supply your
   * own UI: `renderError={(e) => <Box>{formatCallbackError(e)}</Box>}`.
   */
  renderError?: (error: CallbackError) => ReactNode;
}

/**
 * Drop-in callback route component for React Router apps.
 *
 * @example
 *   <Route
 *     path="/auth/callback"
 *     element={<OidcCallback client={authClient} navigateTo="/" />}
 *   />
 */
export function OidcCallback(props: OidcCallbackProps): ReactElement {
  const { client, navigateTo, fallback, renderError } = props;
  const navigate = useNavigate();

  const { status, error } = useOidcCallback(client, {
    onSuccess: () => navigate(navigateTo ?? "/", { replace: true }),
  });

  // `renderError`/`fallback` are `ReactNode` (wider than `ReactElement` — they
  // may be strings or null). Wrapping in a fragment gives this function the
  // `ReactElement` return type the route element slot expects.
  if (status === "error" && error) {
    return (
      <>
        {renderError ? (
          renderError(error)
        ) : (
          <pre data-testid="orpc-ws-oidc-callback-error">
            {formatCallbackError(error)}
          </pre>
        )}
      </>
    );
  }
  return <>{fallback ?? <p>Signing you in…</p>}</>;
}
