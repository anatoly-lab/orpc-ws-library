// Playwright globalSetup.
//
// Boots Keycloak (testcontainers) once before the test run and stashes
// the handle on globalThis so global-teardown can stop it. Playwright's
// globalSetup intentionally has no other shared-state primitive —
// config is serialized across the worker boundary, so the live
// container handle MUST live on the parent's globalThis.
//
// The demo server and SPA are NOT started here. They run as Playwright
// `webServer` entries (see `playwright.config.ts`), which is the
// idiomatic way to manage two long-lived dev processes for an e2e run
// and gives us free log-on-failure surfacing.

import { startKeycloak, type KeycloakHandle } from "./containers.js";

// Augment globalThis so TS knows about the stashed handle.
declare global {
  // eslint-disable-next-line no-var
  var __keycloak: KeycloakHandle | undefined;
}

export default async function globalSetup(): Promise<void> {
  console.log("[setup] Starting Keycloak...");
  const keycloak = await startKeycloak();
  console.log(`[setup] Keycloak ready at ${keycloak.url}`);

  globalThis.__keycloak = keycloak;
}
