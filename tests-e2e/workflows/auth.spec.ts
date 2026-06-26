// Auth cycle: login -> logout -> re-login (cookie-BFF).
//
// Covers what smoke.spec doesn't: that signout properly tears down BOTH ends of
// the session —
//   (a) the SERVER session: the httpOnly `sid` cookie is cleared from the
//       browser context (asserted via context.cookies()), and the signed-out
//       <SignIn /> screen returns; AND
//   (b) the KEYCLOAK session: a fresh signin lands back on the Keycloak login
//       FORM, not a silent SSO bypass.
// Both halves matter — clearing `sid` without the IdP end-session call would
// leave Keycloak able to silently re-issue a session on the next /auth/login.
//
// NOTE on the cookie assertion: cookie-BFF holds NO token in the browser (the
// old PKCE "SPA tokens cleared" check does not apply). The browser's only auth
// artifact is the opaque httpOnly `sid` cookie set by the server — so "logged
// out" is proven by that cookie being gone from the Playwright context.

import { test, expect } from "@playwright/test";

import { KNOWN_TEST_USERS } from "../fixtures/users.js";
import { LoginPage } from "../pages/login.page.js";
import { HomePage } from "../pages/home.page.js";

const SESSION_COOKIE_NAME = "sid";

test("login -> logout -> re-login", async ({ page, context }) => {
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

  // Sanity: the server set the httpOnly `sid` cookie on the server origin.
  const cookiesAfterLogin = await context.cookies();
  expect(cookiesAfterLogin.some((c) => c.name === SESSION_COOKIE_NAME)).toBe(
    true,
  );

  // ---- Logout ----
  await home.signoutButton.click();

  // After logout we end up back on `/` with the signin button visible. The
  // end-session round-trip goes through Keycloak's
  // `/protocol/openid-connect/logout` and bounces back to the
  // post_logout_redirect_uri (`http://localhost:4173/`, registered in the realm).
  await page.waitForURL("http://localhost:4173/", { timeout: 20_000 });
  await expect(home.signinButton).toBeVisible({ timeout: 10_000 });

  // The `sid` cookie must be gone from the browser context — the server's
  // logout response cleared it (Max-Age=0). No token ever existed to clear.
  const cookiesAfterLogout = await context.cookies();
  expect(cookiesAfterLogout.some((c) => c.name === SESSION_COOKIE_NAME)).toBe(
    false,
  );

  // ---- Re-login ----
  // If the previous logout properly killed the Keycloak session, this click
  // should land on the login *form* (not bypass via SSO).
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
