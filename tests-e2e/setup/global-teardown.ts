// Playwright globalTeardown.
//
// Stops the Keycloak container. The demo server and SPA are managed by
// Playwright's `webServer` config and are torn down automatically;
// we only own the testcontainer.

export default async function globalTeardown(): Promise<void> {
  const keycloak = globalThis.__keycloak;

  if (keycloak) {
    try {
      console.log("[teardown] Stopping Keycloak...");
      await keycloak.stop();
    } catch (err) {
      console.error("[teardown] keycloak stop failed:", err);
    }
  }
}
