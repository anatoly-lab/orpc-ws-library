// Auth cycle: login -> logout -> re-login.
//
// Covers the things smoke.spec doesn't: that signout properly clears
// SPA tokens (the signin button reappears) AND clears Keycloak's
// session cookie (a fresh signin lands back on the login form, not a
// silent SSO bypass). Both halves matter — a working `clearTokens()`
// without a working end-session call would leave a tab that survived
// "logout" still able to refresh its token.

import { test, expect } from "@playwright/test";

import { KNOWN_TEST_USERS } from "../fixtures/users.js";
import { LoginPage } from "../pages/login.page.js";
import { HomePage } from "../pages/home.page.js";

test("login -> logout -> re-login", async ({ page }) => {
  const home = new HomePage(page);
  const login = new LoginPage(page);
  const user = KNOWN_TEST_USERS.free;

  // ---- First login ----
  await home.goto();
  await home.signinButton.click();
  await login.waitForKeycloakRedirect();
  await login.fillKeycloakCredentials(user);
  await login.submitKeycloakForm();
  await page.waitForURL("http://localhost:4173/", { timeout: 20_000 });

  await expect(home.userEmail).toContainText(user.email);
  await expect(home.connectionStatus).toContainText("connected", {
    timeout: 15_000,
  });

  // ---- Logout ----
  await home.signoutButton.click();

  // After logout we end up back on `/` with the signin button visible.
  // The end-session round-trip goes through Keycloak (`/protocol/openid-connect/logout`)
  // and bounces back to `post_logout_redirect_uri` (`http://localhost:4173/`).
  await page.waitForURL("http://localhost:4173/", { timeout: 20_000 });
  await expect(home.signinButton).toBeVisible({ timeout: 10_000 });

  // ---- Re-login ----
  // If the previous logout properly killed the Keycloak session, this
  // click should land on the login *form* (not bypass via SSO).
  await home.signinButton.click();
  await login.waitForKeycloakRedirect();
  await expect(login.usernameInput).toBeVisible({ timeout: 10_000 });

  await login.fillKeycloakCredentials(user);
  await login.submitKeycloakForm();
  await page.waitForURL("http://localhost:4173/", { timeout: 20_000 });

  await expect(home.userEmail).toContainText(user.email);
  await expect(home.connectionStatus).toContainText("connected", {
    timeout: 15_000,
  });
});
