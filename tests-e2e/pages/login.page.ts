// Keycloak login page object.
//
// Selector strategy lifted verbatim from
// `anki-mcp-saas/tests/e2e/pages/login.page.ts` — it covers Keycloak
// markup across versions:
//   - v18: `<input type="submit" name="login">`
//   - v25/26: `<input id="kc-login" ...>` (and the matching `name="login"`)
// We compose them with `.or(...)` rather than a single CSS selector
// list so Playwright's locator engine has clear fallback semantics.
//
// `waitForKeycloakRedirect` matches any URL containing `/realms/` —
// covers the login page (`.../realms/<realm>/protocol/openid-connect/auth`)
// AND the callback intermediate (`.../realms/<realm>/login-actions/...`).
// The previous version that also matched `/auth/` was for an app whose
// own page lives at `/auth/...`; our demo uses `/auth/callback` so we
// avoid that prefix to prevent false-positive matches.

import type { Page, Locator } from "@playwright/test";

export interface KeycloakCredentials {
  username: string;
  password: string;
}

export class LoginPage {
  readonly page: Page;

  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.usernameInput = page.locator("#username");
    this.passwordInput = page.locator("#password");
    // Keycloak 26 ships `#kc-login`; older themes shipped a plain
    // `<input type="submit" name="login">` with no stable id. `.or()`
    // returns whichever matches first.
    this.submitButton = page
      .locator("#kc-login")
      .or(page.locator('input[type="submit"][name="login"]'))
      .first();
  }

  async fillKeycloakCredentials(creds: KeycloakCredentials): Promise<void> {
    await this.usernameInput.waitFor({ state: "visible", timeout: 10_000 });
    await this.usernameInput.fill(creds.username);
    await this.passwordInput.fill(creds.password);
  }

  async submitKeycloakForm(): Promise<void> {
    await this.submitButton.click();
  }

  /**
   * Wait for navigation to a Keycloak realm URL — i.e., the PKCE
   * authorize redirect has landed and the KC login form is rendering.
   */
  async waitForKeycloakRedirect(timeout = 20_000): Promise<void> {
    await this.page.waitForURL(/\/realms\//, { timeout });
  }
}
