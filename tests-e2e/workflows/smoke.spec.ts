// Smoke test: drives the full happy-path stack — PKCE login, WS
// connect, ORPC ping, ORPC echo with auth context.
//
// This is the single non-negotiable E2E gate. If it fails, something
// in the SPA-server-Keycloak triangle is broken in a way no
// per-package unit test would catch (auth handshake, WS upgrade,
// ORPC framing). Most regressions show up here first.

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

  // Back on the SPA. The redirect lands on /auth/callback, then the
  // callback handler navigates to /. Wait for the final URL.
  await page.waitForURL("http://localhost:18081/", { timeout: 20_000 });

  await expect(home.userEmail).toContainText(KNOWN_TEST_USERS.free.email);
  await expect(home.connectionStatus).toContainText("connected", {
    timeout: 15_000,
  });

  await home.pingButton.click();
  await expect(home.pingResult).toContainText("pong", { timeout: 5_000 });

  await home.echoButton.click();
  await expect(home.echoResult).toContainText(KNOWN_TEST_USERS.free.email, {
    timeout: 5_000,
  });
});
