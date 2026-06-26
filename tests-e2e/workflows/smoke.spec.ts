// Smoke test: drives the full happy-path cookie-BFF stack — server-side OIDC
// login, httpOnly session cookie, WS connect (cookie rides the upgrade, NO
// `?token=`), ORPC ping, ORPC echo with the cookie-derived auth context.
//
// This is the single non-negotiable E2E gate. If it fails, something in the
// SPA-server-Keycloak triangle is broken in a way no per-package unit test
// would catch (the server-side code exchange, the cookie set on /auth/callback,
// the cookie WS handshake, ORPC framing). Most regressions show up here first.
//
// Cookie-BFF flow (vs the old PKCE flow): the SPA's signin-button navigates to
// the SERVER's /auth/login; the server 302s to Keycloak; after the user
// authenticates, Keycloak redirects to the SERVER's /auth/callback (NOT a SPA
// route), which sets the httpOnly `sid` cookie and 302s back to the SPA root.
// The SPA then calls GET /auth/me (cookie rides automatically) and renders Home.

import { test, expect } from "@playwright/test";

import { KNOWN_TEST_USERS } from "../fixtures/users.js";
import { LoginPage } from "../pages/login.page.js";
import { HomePage } from "../pages/home.page.js";

test("login -> connection -> ping -> echo", async ({ page }) => {
  const home = new HomePage(page);
  const login = new LoginPage(page);

  await home.goto();
  await expect(home.signinButton).toBeVisible();
  await home.signinButton.click();

  await login.waitForKeycloakRedirect();
  await login.fillKeycloakCredentials(KNOWN_TEST_USERS.free);
  await login.submitKeycloakForm();

  // Back on the SPA. Keycloak → server /auth/callback (sets `sid`, 302s to the
  // SPA root). Wait for the final SPA-root URL the callback redirects to.
  await page.waitForURL("http://localhost:4173/", { timeout: 20_000 });

  // Identity comes from GET /auth/me (cookie-authed) — the browser holds no
  // token to decode; the email is the server session's enriched user.
  await expect(home.userEmail).toContainText(KNOWN_TEST_USERS.free.email);

  // The `sid` cookie rides the WS upgrade automatically (no `?token=`); the
  // server authenticates the connection from the cookie alone.
  await expect(home.connectionStatus).toContainText("connected", {
    timeout: 15_000,
  });

  await home.pingButton.click();
  await expect(home.pingResult).toContainText("pong", { timeout: 5_000 });

  // echo's `user` field is the cookie-derived principal's email — proves the
  // server propagated the session user into the ORPC handler over WS.
  await home.echoButton.click();
  await expect(home.echoResult).toContainText(KNOWN_TEST_USERS.free.email, {
    timeout: 5_000,
  });
});
