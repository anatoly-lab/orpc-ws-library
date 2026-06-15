// SignIn — the demo's signed-out screen.
//
// AppLayout renders this when GET /auth/me finds no server session. Sign-in is a
// full-page navigation to the SERVER's /auth/login (which 302s to Keycloak),
// NOT a library call — this app imports no oidc package. App branding lives
// HERE.

import type { ReactElement } from "react";

import { login } from "../lib/auth.js";
import styles from "./styles.module.css";

export function SignIn(): ReactElement {
  return (
    <main className={styles.container}>
      <h1>orpc-ws-library demo (cookie-bff)</h1>
      <p>You are not signed in.</p>
      <button
        data-testid="signin-button"
        onClick={() => login()}
        className={styles.button}
      >
        Sign in with Keycloak
      </button>
    </main>
  );
}
