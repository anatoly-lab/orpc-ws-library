// React adapter — `<RequireAuth>` auth gate component.
//
// Lifts the per-page "signed out? show sign-in" check out of individual
// pages into one reusable guard. Wrap any protected subtree (an `<Outlet />`,
// a page, a section); `children` render only when a token is present, and a
// `fallback` (a sign-in screen) renders otherwise.
//
// Router-free by design: it gates an arbitrary `ReactNode` the consumer
// passes in, so it never imports react-router. That keeps it in the package's
// MAIN entry (CLAUDE.md "Adapter wiring convention" — only `react` peer here;
// router coupling stays behind the `./react-router` sub-path).

import type { ReactElement, ReactNode } from "react";

import type { OidcAuth } from "@orpc-ws/oidc-pkce";

import { useAuthState } from "./use-auth-state.js";

/** Props for {@link RequireAuth}. */
export interface RequireAuthProps {
  /** The `OidcAuth` instance (from `createOidcAuth`). Stable across renders. */
  client: OidcAuth;
  /**
   * Rendered ONLY when a token is present — i.e. `status` is `authenticated`
   * OR `expired` (see the gate-predicate note in the component body).
   */
  children: ReactNode;
  /**
   * Rendered when `status` is `anonymous` (no token). Optional — defaults to a
   * minimal, app-neutral signed-out UI with a sign-in button. Pass your own to
   * supply app branding / copy / testids.
   */
  fallback?: ReactNode;
}

/**
 * Gate a protected subtree on auth state.
 *
 * @example
 *   // Layout route — wrap the Outlet, pass your own sign-in screen.
 *   <RequireAuth client={authClient} fallback={<SignIn />}>
 *     <Outlet />
 *   </RequireAuth>
 */
export function RequireAuth(props: RequireAuthProps): ReactElement {
  const { client, children, fallback } = props;
  const { status } = useAuthState(client);

  // GATE PREDICATE: token present (`status !== "anonymous"`), NOT strictly
  // "authenticated". An EXPIRED token must still render the protected content
  // so the library's reconnect+refresh recovery can run: the WS sends the
  // stale token, the server closes with 1008, and `tokenProvider.refresh()`
  // restores the session. Gating on `=== "authenticated"` would bounce an
  // expired session back to sign-in mid-recovery, regressing reconnection
  // after a token lapses. This mirrors the demo's existing
  // `status !== "anonymous"` semantics (see AppLayout's connect guard).
  if (status !== "anonymous") {
    // `children` is a `ReactNode` (may be a string/array/null); wrap in a
    // fragment so this function satisfies its `ReactElement` return type,
    // mirroring `OidcCallback`.
    return <>{children}</>;
  }

  return <>{fallback ?? <DefaultSignedOut client={client} />}</>;
}

/**
 * Minimal, app-neutral signed-out UI used when no `fallback` is supplied.
 *
 * Deliberately generic — NO app branding (product name, IdP name). Consumers
 * style/brand by passing their own `fallback`, exactly as `OidcCallback`'s
 * `renderError`/`fallback` defaults stay generic and overridable.
 */
function DefaultSignedOut({ client }: { client: OidcAuth }): ReactElement {
  return (
    <div>
      <p>You are not signed in.</p>
      <button
        type="button"
        data-testid="orpc-ws-oidc-signin"
        onClick={() => {
          // `redirectToLogin` awaits OIDC discovery before navigating; we
          // discard the returned promise because the page navigates before it
          // settles (and the click handler can't be async).
          void client.redirectToLogin();
        }}
      >
        Sign in
      </button>
    </div>
  );
}
