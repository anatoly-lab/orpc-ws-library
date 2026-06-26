// Demo SPA page object (cookie-BFF mode).
//
// Selectors are all `data-testid` because the SPA was deliberately built
// with that affordance (apps/demo-cookie-bff/client/src/pages/{SignIn,Home}.tsx
// + AppLayout.tsx). No class chains or role lookups — those add brittleness
// without buying anything when the dev controls both sides.
//
// One object covers BOTH the signed-out screen (<SignIn />: `signin-button`)
// and the signed-in screen (<Home />: connection/ping/echo/getUser/sign-out),
// because in this SPA they are two render branches of the same route — there is
// no separate URL to model. `authChecking` is AppLayout's "Checking session..."
// gate shown while GET /auth/me is in flight.

import type { Page, Locator } from "@playwright/test";

export class HomePage {
  readonly page: Page;

  // Signed-out (<SignIn />).
  readonly signinButton: Locator;

  // AppLayout gate, shown while /auth/me resolves.
  readonly authChecking: Locator;

  // Signed-in (<Home />).
  readonly signoutButton: Locator;
  readonly connectionStatus: Locator;
  readonly userEmail: Locator;
  readonly pingButton: Locator;
  readonly pingResult: Locator;
  readonly echoButton: Locator;
  readonly echoResult: Locator;
  readonly getUserButton: Locator;
  readonly getUserResult: Locator;
  readonly lastTick: Locator;
  readonly actionError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.signinButton = page.getByTestId("signin-button");
    this.authChecking = page.getByTestId("auth-checking");
    this.signoutButton = page.getByTestId("signout-button");
    this.connectionStatus = page.getByTestId("connection-status");
    this.userEmail = page.getByTestId("user-email");
    this.pingButton = page.getByTestId("ping-button");
    this.pingResult = page.getByTestId("ping-result");
    this.echoButton = page.getByTestId("echo-button");
    this.echoResult = page.getByTestId("echo-result");
    this.getUserButton = page.getByTestId("get-user-button");
    this.getUserResult = page.getByTestId("get-user-result");
    this.lastTick = page.getByTestId("last-tick");
    this.actionError = page.getByTestId("action-error");
  }

  async goto(): Promise<void> {
    await this.page.goto("/");
  }
}
