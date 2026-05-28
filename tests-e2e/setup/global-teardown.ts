// Playwright globalTeardown.
//
// Stops the demo server child process and the Keycloak container.
// Each stop is wrapped so one failure doesn't mask the other —
// otherwise we'd routinely leak Keycloak containers when the demo
// server fails to die cleanly.

export default async function globalTeardown(): Promise<void> {
  const demo = globalThis.__demo;
  const keycloak = globalThis.__keycloak;

  if (demo) {
    try {
      console.log("[teardown] Stopping demo server...");
      await demo.stop();
    } catch (err) {
      console.error("[teardown] demo-server stop failed:", err);
    }
  }

  if (keycloak) {
    try {
      console.log("[teardown] Stopping Keycloak...");
      await keycloak.stop();
    } catch (err) {
      console.error("[teardown] keycloak stop failed:", err);
    }
  }
}
