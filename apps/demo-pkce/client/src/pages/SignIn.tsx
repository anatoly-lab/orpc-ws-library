// SignIn — the demo's signed-out screen.
//
// This is the app-specific `fallback` AppLayout hands to the library's
// `<RequireAuth>` guard. It used to live inline in Home's `if (!loggedIn)`
// branch; lifting it here keeps Home authed-only and gives the gate a single,
// branded sign-in screen. App branding (product name, "Keycloak") lives HERE,
// not in the library's neutral default fallback.

import type { ReactElement } from "react";

import { authClient } from "../lib/ws-client.js";
import styles from "./styles.module.css";

export function SignIn(): ReactElement {
  return (
    <main className={styles.container}>
      <h1>orpc-ws-library demo</h1>
      <p>You are not signed in.</p>
      <button
        data-testid="signin-button"
        onClick={() => {
          // redirectToLogin awaits OIDC discovery before navigating; we
          // discard the returned promise because the page navigates
          // before it settles in production.
          void authClient.redirectToLogin();
        }}
        className={styles.button}
      >
        Sign in with Keycloak
      </button>
    </main>
  );
}
