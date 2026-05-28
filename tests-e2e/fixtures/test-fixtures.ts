// Playwright test fixtures.
//
// `keycloakUser` exposes the seed user as injectable test data; tests
// take it as a destructured fixture argument and don't need to import
// the constants module directly. Keeps user identity selection in one
// place if/when we add per-test user pools.
//
// `authenticatedPage` performs the full PKCE login once per test that
// uses it, then hands back the page already on `/`. Most tests should
// prefer the raw `page` fixture + explicit LoginPage interactions —
// driving the login flow is what we're testing — but for tests that
// only care about post-login behavior (RPC, reconnect), the
// authenticated fixture removes ~10 lines of boilerplate.

import { test as base, type Page } from "@playwright/test";

import { KNOWN_TEST_USERS, type KnownTestUser } from "./users.js";
import { LoginPage } from "../pages/login.page.js";
import { HomePage } from "../pages/home.page.js";

interface Fixtures {
  keycloakUser: KnownTestUser;
  authenticatedPage: Page;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  keycloakUser: async ({}, use) => {
    await use(KNOWN_TEST_USERS.free);
  },

  authenticatedPage: async ({ page, keycloakUser }, use) => {
    const home = new HomePage(page);
    const login = new LoginPage(page);

    await home.goto();
    await home.signinButton.click();
    await login.waitForKeycloakRedirect();
    await login.fillKeycloakCredentials(keycloakUser);
    await login.submitKeycloakForm();
    await page.waitForURL("http://localhost:18081/", { timeout: 20_000 });

    await use(page);
  },
});

export { expect } from "@playwright/test";
