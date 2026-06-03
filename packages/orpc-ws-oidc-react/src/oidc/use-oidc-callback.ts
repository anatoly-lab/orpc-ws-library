// React adapter — `useOidcCallback` hook (router-free, main entry).
//
// Generalizes the demo app's hand-rolled callback page into a reusable hook.
// It drives the OIDC redirect-back exchange ONCE on mount and surfaces the
// outcome as React state (`status` + `error`) plus optional imperative
// callbacks (`onSuccess` / `onError`). The consumer owns navigation and UI —
// this hook is deliberately router-agnostic so it works with React Router,
// TanStack Router, plain `window.location`, or no router at all. The
// react-router-dom-bound `OidcCallback` component (sub-path) is built ON TOP
// of this hook; there is no logic duplication between them.

import { useEffect, useRef, useState } from "react";

import type { CallbackError, OidcAuth } from "@repo/oidc-pkce";

/** Optional imperative side-effect callbacks for the callback exchange. */
export interface UseOidcCallbackOptions {
  /** Fired once after a successful token exchange. Typical use: navigate home. */
  onSuccess?: () => void;
  /** Fired once with the failure variant when the exchange fails. */
  onError?: (error: CallbackError) => void;
}

/** Reactive result of the callback exchange. Drives the page's render. */
export interface UseOidcCallbackResult {
  /**
   * - `pending`: the exchange is in flight, OR no flow is active (see the
   *   empty-params guard below — a direct hit on the callback route with no
   *   `?code`/`?error` stays `pending` forever, intentionally).
   * - `success`: tokens were persisted; safe to navigate into the app.
   * - `error`: the exchange failed; inspect {@link UseOidcCallbackResult.error}.
   */
  status: "pending" | "success" | "error";
  /** The failure variant when `status === "error"`, else `null`. */
  error: CallbackError | null;
}

/**
 * Run the OIDC callback exchange once on mount and observe its outcome.
 *
 * @param client - the `OidcAuth` returned by `createOidcAuth`. Pass the SAME
 *   instance across renders (typically a module-level singleton) — the effect
 *   depends on it for identity stability.
 * @param options - optional `onSuccess` / `onError` side-effect callbacks. The
 *   object may be a fresh inline literal every render; the hook reads it
 *   through a ref so a new object does NOT re-run the exchange (see below).
 *
 * @returns the reactive {@link UseOidcCallbackResult}.
 *
 * @example
 *   const { status, error } = useOidcCallback(authClient, {
 *     onSuccess: () => navigate("/", { replace: true }),
 *   });
 *   if (status === "error") return <pre>{error.type}</pre>;
 *   return <p>Signing you in…</p>;
 */
export function useOidcCallback(
  client: OidcAuth,
  options?: UseOidcCallbackOptions,
): UseOidcCallbackResult {
  const [status, setStatus] =
    useState<UseOidcCallbackResult["status"]>("pending");
  const [error, setError] = useState<CallbackError | null>(null);

  // The ran-guard is a REF, not state, for two reasons:
  //   1. It must persist across React StrictMode's dev mount→unmount→mount
  //      without triggering a render (a state write would).
  //   2. `handleCallback` is NON-idempotent: it consumes the one-shot PKCE
  //      verifier+state from sessionStorage and the single-use authorization
  //      code. A second call would fail with `state_mismatch`. The guard
  //      ensures exactly-once even under the double-invoke. Mirrors the
  //      original demo `Callback.tsx` ref-guard.
  const ran = useRef(false);

  // Latest-options via ref: we want `onSuccess`/`onError` to see the freshest
  // closures the consumer passed (latest-callback semantics) WITHOUT putting
  // `options` in the effect dep array. Consumers commonly pass an inline
  // object literal, which has a new identity every render; depending on it
  // would re-subscribe the effect on every render. Keeping deps to `[client]`
  // plus reading callbacks through this ref is the clean split. (The ran-guard
  // already blocks a second exchange, but a re-running effect is still
  // wasteful churn we avoid by construction.)
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (ran.current) return;

    // EMPTY-PARAMS GUARD. If the callback route is hit WITHOUT an IdP result
    // in the query string — a direct navigation, a bookmark, or a refresh
    // after the flow already completed — there is nothing to exchange. We
    // leave `status` at `pending` and do nothing: no `handleCallback` call,
    // no spurious error. Crucially we do NOT set the ran-guard on this bail
    // path, so we don't burn the one-shot guard on a no-op: if the effect
    // ever re-runs (the consumer swaps the `client` instance) at a point
    // where params ARE present, the exchange can still proceed.
    //
    // Trigger predicate: `code` OR `error` present. `code` is the success
    // path; `error` is the OAuth 2.0 authorization-error response
    // (`?error=access_denied&error_description=…`, RFC 6749 §4.1.2.1). Gating
    // on `code` ALONE would silently swallow IdP-reported failures — the
    // library's `idp_error` callback variant exists precisely to be shown to
    // the user, so it must be allowed to reach `handleCallback`.
    const params = new URLSearchParams(window.location.search);
    if (!params.has("code") && !params.has("error")) return;

    ran.current = true;
    void (async (): Promise<void> => {
      const result = await client.handleCallback(params);
      if (!result.ok) {
        setStatus("error");
        setError(result.error);
        optionsRef.current?.onError?.(result.error);
        return;
      }
      setStatus("success");
      optionsRef.current?.onSuccess?.();
    })();
    // Deliberately `[client]` only — see the optionsRef rationale above.
  }, [client]);

  return { status, error };
}
