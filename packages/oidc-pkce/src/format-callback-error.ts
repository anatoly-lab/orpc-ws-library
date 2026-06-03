// CallbackError → human-readable string.
//
// Owns the DEFAULT rendering of the `CallbackError` union it sits next to.
// It lives in the core (not the React adapter) for two reasons: it is a pure,
// framework-free `string`-returning function, and — load-bearing — it must be
// co-located with the union so the exhaustiveness guard keeps the copy in
// LOCKSTEP with the variants. The `default` branch assigns `err` to `never`:
// add a `CallbackError` variant and this file fails to compile until copy for
// it is added here, rather than silently falling through to nothing.
//
// The copy is deliberately NEUTRAL — complete English sentences, no product or
// IdP brand names — so it is shippable on day 0 and localizable later. The
// `exchange_failed` branch includes the raw server `body` ON PURPOSE, for
// debuggability of token-endpoint failures; apps that would rather not surface
// raw server output to end users override the rendering (see the adapter's
// `renderError` prop on `<OidcCallback>`).

import type { CallbackError } from "./types.js";

/** Render a {@link CallbackError} as neutral, day-0-shippable default copy. */
export function formatCallbackError(err: CallbackError): string {
  switch (err.type) {
    case "state_mismatch":
      return "Sign-in could not be verified — the request may have expired or been replayed. Please try signing in again.";
    case "missing_code":
      return "The sign-in response was missing its authorization code.";
    case "exchange_failed":
      // Raw `body` appended for debuggability — overridable, see file header.
      return `Sign-in failed while exchanging the authorization code (HTTP ${err.status}).\n${err.body}`;
    case "idp_error":
      return `The identity provider reported an error: ${err.error}${err.description ? `\n${err.description}` : ""}`;
    default: {
      // Exhaustiveness guard: a new `CallbackError` variant makes this assign
      // fail to compile until copy for it is added above.
      const _exhaustive: never = err;
      return _exhaustive;
    }
  }
}
