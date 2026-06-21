// Demo SPA home page object.
//
// Selectors are all `data-testid` because the SPA was deliberately built
// with that affordance (apps/demo-pkce/client/src/pages/Home.tsx). No class
// chains or role lookups — those add brittleness without buying
// anything when the dev controls both sides.

import type { Page, Locator } from "@playwright/test";

export class HomePage {
  readonly page: Page;

  readonly signinButton: Locator;
  readonly signoutButton: Locator;
  readonly connectionStatus: Locator;
  readonly userEmail: Locator;
  readonly pingButton: Locator;
  readonly pingResult: Locator;
  readonly echoButton: Locator;
  readonly echoResult: Locator;
  readonly actionError: Locator;

  constructor(page: Page) {
    this.page = page;
    this.signinButton = page.getByTestId("signin-button");
    this.signoutButton = page.getByTestId("signout-button");
    this.connectionStatus = page.getByTestId("connection-status");
    this.userEmail = page.getByTestId("user-email");
    this.pingButton = page.getByTestId("ping-button");
    this.pingResult = page.getByTestId("ping-result");
    this.echoButton = page.getByTestId("echo-button");
    this.echoResult = page.getByTestId("echo-result");
    this.actionError = page.getByTestId("action-error");
  }

  async goto(): Promise<void> {
    await this.page.goto("/");
  }
}
